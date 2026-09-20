"""Composio shopping catalog — third source when Shopify is thin.

Uses COMPOSIO_SEARCH_SHOPPING (no OAuth). Maps hits into ProductCandidate
with ``source: composio`` so VisualJudge and the honesty ranker stay unchanged.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

import requests

from logging_config import agent_log, garment_name
from services.shopify_filter import _first, normalize_product


logger = logging.getLogger("fit_stealer.composio")

COMPOSIO_EXECUTE_URL = (
    "https://backend.composio.dev/api/v3.1/tools/execute/COMPOSIO_SEARCH_SHOPPING"
)
COMPOSIO_TOOLKIT_VERSION = "20260618_00"
DEFAULT_LIMIT = 8


class ComposioShoppingError(RuntimeError):
    """A recoverable Composio shopping failure."""


def composio_mode() -> str:
    raw = os.getenv("COMPOSIO_SHOPPING", "auto").strip().lower()
    if raw in {"0", "off", "false", "no"}:
        return "off"
    if raw in {"always", "1", "on", "true"}:
        return "always"
    return "auto"


def composio_configured() -> bool:
    return bool(os.getenv("COMPOSIO_API_KEY", "").strip()) and composio_mode() != "off"


def _parse_price(item: dict[str, Any]) -> tuple[str | None, str | None]:
    extracted = _first(item, "extracted_price", "extractedPrice", "price_value")
    if isinstance(extracted, (int, float)) and not isinstance(extracted, bool):
        currency = _first(item, "currency", "currency_code", "currencyCode") or "USD"
        return f"{float(extracted):.2f}", str(currency).upper()
    raw = _first(item, "price", "displayed_price")
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        currency = _first(item, "currency") or "USD"
        amount = float(raw)
        if amount >= 100 and float(raw).is_integer():
            amount = amount / 100.0
        return f"{amount:.2f}", str(currency).upper()
    if isinstance(raw, str):
        digits = "".join(ch for ch in raw if ch.isdigit() or ch in ".,")
        digits = digits.replace(",", "")
        try:
            return f"{float(digits):.2f}", "USD"
        except ValueError:
            return None, None
    return None, None


def normalize_shopping_item(item: dict[str, Any]) -> dict[str, Any] | None:
    """Convert one Composio / Google Shopping row into ``ProductCandidate``."""
    if not isinstance(item, dict):
        return None
    shopify_shaped = normalize_product({**item, "source": "composio"})
    if shopify_shaped:
        shopify_shaped["source"] = "composio"
        return shopify_shaped
    title = _first(item, "title", "name", "product_title", "productName")
    url = _first(
        item,
        "link",
        "url",
        "product_link",
        "productLink",
        "product_url",
        "source_link",
        "merchant_link",
    )
    if not isinstance(title, str) or not isinstance(url, str):
        return None
    if not url.startswith(("https://", "http://")):
        return None
    candidate: dict[str, Any] = {
        "title": title.strip(),
        "url": url,
        "source": "composio",
    }
    image = _first(
        item,
        "thumbnail",
        "image_url",
        "imageUrl",
        "image",
        "thumbnail_url",
        "serpapi_thumbnail",
    )
    if isinstance(image, dict):
        image = _first(image, "url", "src", "link")
    if isinstance(image, str) and image.startswith(("https://", "http://")):
        candidate["image_url"] = image
    price, currency = _parse_price(item)
    if price:
        candidate["price"] = price
    if currency:
        candidate["currency"] = currency
    store = _first(item, "source", "store_name", "storeName", "merchant", "seller")
    if isinstance(store, dict):
        store = _first(store, "name", "title")
    if isinstance(store, str) and store.strip() and store.strip().lower() not in {"composio"}:
        candidate["store_name"] = store.strip()
    return candidate


def _looks_like_product(item: dict[str, Any]) -> bool:
    title = _first(item, "title", "name", "product_title")
    url = _first(item, "link", "url", "product_link", "product_url", "source_link")
    return isinstance(title, str) and isinstance(url, str)


def _walk_products(payload: Any, acc: list[dict[str, Any]], depth: int = 0) -> None:
    if depth > 6 or payload is None:
        return
    if isinstance(payload, str):
        text = payload.strip()
        if text.startswith("{") or text.startswith("["):
            try:
                _walk_products(json.loads(text), acc, depth + 1)
            except json.JSONDecodeError:
                return
        return
    if isinstance(payload, list):
        dicts = [item for item in payload if isinstance(item, dict)]
        if dicts and sum(1 for item in dicts if _looks_like_product(item)) >= max(1, len(dicts) // 2):
            acc.extend(dicts)
            return
        for item in payload:
            _walk_products(item, acc, depth + 1)
        return
    if not isinstance(payload, dict):
        return
    for key in (
        "shopping_results",
        "shoppingResults",
        "products",
        "items",
        "organic_results",
        "inline_shopping_results",
    ):
        value = payload.get(key)
        if isinstance(value, list):
            _walk_products(value, acc, depth + 1)
    for key in ("data", "result", "results", "response", "payload"):
        if key in payload:
            _walk_products(payload[key], acc, depth + 1)


def extract_shopping_items(payload: Any) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    _walk_products(payload, found)
    return found


def search_composio_shopping(
    garment: dict[str, Any],
    *,
    query: str | None = None,
    limit: int = DEFAULT_LIMIT,
    timeout: float = 8.0,
    session: requests.Session | None = None,
) -> list[dict[str, Any]]:
    """Search Composio shopping. Empty list if unconfigured or the call fails."""
    if not composio_configured():
        return []
    query = str(query or garment.get("search_query") or garment.get("description") or "").strip()
    if not query:
        return []
    api_key = os.getenv("COMPOSIO_API_KEY", "").strip()
    name = garment_name(garment)
    logger.info('composio — %s: searching "%s"', name, query[:80])
    body = {
        "user_id": os.getenv("COMPOSIO_USER_ID", "fit-stealer"),
        "entity_id": os.getenv("COMPOSIO_USER_ID", "fit-stealer"),
        "arguments": {
            "query": query,
            "gl": os.getenv("COMPOSIO_SHOPPING_GL", "ca"),
            "hl": "en",
        },
        "version": os.getenv("COMPOSIO_TOOLKIT_VERSION", COMPOSIO_TOOLKIT_VERSION),
        "dangerously_skip_version_check": True,
    }
    client = session or requests.Session()
    try:
        response = client.post(
            COMPOSIO_EXECUTE_URL,
            json=body,
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
                "x-api-key": api_key,
            },
            timeout=timeout,
        )
        response.raise_for_status()
        payload = response.json()
    except (requests.RequestException, ValueError) as exc:
        logger.warning("composio — %s: failed (%s)", name, exc)
        agent_log(
            "D",
            "composio_shopping.py:search",
            "composio shopping failed",
            {"category": name, "query": query[:120], "error": str(exc)[:200]},
        )
        return []

    if isinstance(payload, dict) and payload.get("successful") is False:
        logger.warning("composio — %s: unsuccessful (%s)", name, payload.get("error"))
        return []

    raw_items = extract_shopping_items(payload)
    candidates: list[dict[str, Any]] = []
    for item in raw_items:
        normalized = normalize_shopping_item(item)
        if normalized:
            candidates.append(normalized)
        if len(candidates) >= max(1, min(int(limit), 10)):
            break
    logger.info("composio — %s: %s products", name, len(candidates))
    agent_log(
        "D",
        "composio_shopping.py:search",
        "composio shopping results",
        {
            "category": name,
            "query": query[:120],
            "rawItems": len(raw_items),
            "normalized": len(candidates),
            "titles": [item.get("title") for item in candidates],
        },
    )
    return candidates
