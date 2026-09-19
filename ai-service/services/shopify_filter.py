"""Shopify Global Catalog sourcing for Stage 1.

The Global Catalog uses a public UCP agent profile; it does not use a
Shopify Admin or Storefront API key. This module returns the small
ProductCandidate contract consumed by the ranker.
"""

from __future__ import annotations

import base64
import logging
import os
import time
from pathlib import Path
from typing import Any

import requests

from logging_config import agent_log, garment_name


logger = logging.getLogger("fit_stealer.shopify")

SHOPIFY_CATALOG_URL = "https://catalog.shopify.com/api/ucp/mcp"
DEFAULT_AGENT_PROFILE_URL = (
    "https://shopify.dev/ucp/agent-profiles/2026-04-08/"
    "valid-with-capabilities.json"
)


class ShopifyCatalogError(RuntimeError):
    """A recoverable Shopify transport or protocol failure."""


def encode_chip(chip_path: str | Path) -> str:
    """Return a raw base64 JPEG/PNG payload for Shopify's ``like`` input."""
    path = Path(chip_path)
    if not path.is_file():
        raise ValueError(f"Garment chip not found: {path}")
    return base64.b64encode(path.read_bytes()).decode("ascii")


def _first(mapping: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        value = mapping.get(key)
        if value not in (None, "", [], {}):
            return value
    return None


def _price_and_currency(product: dict[str, Any]) -> tuple[str | None, str | None]:
    price_range = _first(product, "price_range", "priceRange") or {}
    if not isinstance(price_range, dict):
        price_range = {}
    price = _first(product, "price", "min_price", "minPrice")
    currency = _first(product, "currency", "currency_code", "currencyCode")
    if isinstance(price, dict):
        currency = currency or _first(price, "currency", "currency_code", "currencyCode")
        price = _first(price, "amount", "value")
    minimum = _first(price_range, "min", "minimum", "min_price", "minPrice")
    if isinstance(minimum, dict):
        price = price or _first(minimum, "amount", "value")
        currency = currency or _first(
            minimum, "currency", "currency_code", "currencyCode"
        )
    elif minimum is not None:
        price = price or minimum
    currency = currency or _first(
        price_range, "currency", "currency_code", "currencyCode"
    )
    if isinstance(price, int) and not isinstance(price, bool):
        formatted = f"{price / 100:.2f}"
    elif isinstance(price, float):
        formatted = f"{price:.2f}"
    elif isinstance(price, str):
        try:
            formatted = f"{float(price):.2f}"
        except ValueError:
            formatted = None
    else:
        formatted = None
    return formatted, str(currency).upper() if currency else None


def _image_url(product: dict[str, Any]) -> str | None:
    direct = _first(product, "image_url", "imageUrl", "featured_image")
    if isinstance(direct, str):
        return direct
    media = product.get("media") or product.get("images") or []
    if isinstance(media, dict):
        media = [media]
    for item in media:
        if isinstance(item, str):
            return item
        if isinstance(item, dict):
            url = _first(item, "url", "src", "image_url", "imageUrl")
            if isinstance(url, str):
                return url
            image = item.get("image")
            if isinstance(image, dict):
                url = _first(image, "url", "src")
                if isinstance(url, str):
                    return url
    return None


def normalize_product(product: dict[str, Any]) -> dict[str, Any] | None:
    """Convert one Global Catalog product into ``ProductCandidate``."""
    title = _first(product, "title", "name")
    url = _first(product, "url", "online_store_url", "onlineStoreUrl", "checkout_url")
    variants = product.get("variants") or []
    variant = next(
        (
            item
            for item in variants
            if isinstance(item, dict)
            and (item.get("availability") or {}).get("available", True)
        ),
        {},
    )
    if not url and isinstance(variant, dict):
        url = _first(variant, "url", "checkout_url", "checkoutUrl")
    if not isinstance(title, str) or not isinstance(url, str):
        return None
    if not url.startswith(("https://", "http://")):
        return None
    price, currency = _price_and_currency(product)
    if not price and isinstance(variant, dict):
        price, currency = _price_and_currency(variant)
    merchant = product.get("merchant") or product.get("store") or {}
    if not merchant and isinstance(variant, dict):
        merchant = variant.get("seller") or {}
    store_name = _first(product, "store_name", "storeName", "merchant_name")
    if not store_name and isinstance(merchant, dict):
        store_name = _first(merchant, "name", "title")
    candidate: dict[str, Any] = {
        "title": title.strip(),
        "url": url,
        "source": "shopify",
    }
    image_url = _image_url(product)
    if image_url:
        candidate["image_url"] = image_url
    if price:
        candidate["price"] = price
    if currency:
        candidate["currency"] = currency
    if store_name:
        candidate["store_name"] = str(store_name)
    score = _first(product, "score", "relevance_score", "relevanceScore")
    if isinstance(score, (int, float)) and not isinstance(score, bool):
        candidate["raw_score"] = float(score)
    return candidate


def _extract_products(payload: dict[str, Any]) -> list[dict[str, Any]]:
    if payload.get("error"):
        error = payload["error"]
        message = error.get("message", str(error)) if isinstance(error, dict) else str(error)
        raise ShopifyCatalogError(message)
    result = payload.get("result") or {}
    structured = result.get("structuredContent") or result.get("structured_content") or {}
    catalog = structured.get("catalog") if isinstance(structured, dict) else None
    for container in (structured, catalog, result):
        if not isinstance(container, dict):
            continue
        products = container.get("products") or container.get("items")
        if isinstance(products, list):
            return [item for item in products if isinstance(item, dict)]
    return []


def search_shopify_catalog(
    garment: dict[str, Any],
    chip_base64: str | None = None,
    *,
    limit: int = 5,
    country: str = "CA",
    currency: str = "CAD",
    timeout: float = 15.0,
    session: requests.Session | None = None,
) -> list[dict[str, Any]]:
    """Search Global Catalog by garment text and optional cropped image."""
    query = str(garment.get("search_query") or garment.get("description") or "").strip()
    if not query:
        raise ValueError("garment.search_query or garment.description is required")
    limit = max(1, min(int(limit), 10))
    name = garment_name(garment)
    chip_note = "with photo chip" if chip_base64 else "text only, no chip"
    logger.info('shopify — %s: searching "%s" (%s)', name, query[:80], chip_note)
    catalog: dict[str, Any] = {
        "query": query,
        "filters": {
            "available": True,
            "ships_to": {"country": country.upper()},
        },
        "context": {
            "address_country": country.upper(),
            "currency": currency.upper(),
        },
        "pagination": {"limit": limit},
    }
    if chip_base64:
        catalog["like"] = [
            {"image": {"content_type": "image/jpeg", "data": chip_base64}}
        ]
    profile = os.getenv("SHOPIFY_AGENT_PROFILE_URL", DEFAULT_AGENT_PROFILE_URL)
    body = {
        "jsonrpc": "2.0",
        "method": "tools/call",
        "id": 1,
        "params": {
            "name": "search_catalog",
            "arguments": {
                "meta": {"ucp-agent": {"profile": profile}},
                "catalog": catalog,
            },
        },
    }
    client = session or requests.Session()
    try:
        response = client.post(
            SHOPIFY_CATALOG_URL,
            json=body,
            headers={"Accept": "application/json", "Content-Type": "application/json"},
            timeout=timeout,
        )
        response.raise_for_status()
        payload = response.json()
    except (requests.RequestException, ValueError) as exc:
        raise ShopifyCatalogError(f"Shopify Global Catalog request failed: {exc}") from exc
    try:
        products = _extract_products(payload)
    except ShopifyCatalogError as exc:
        message = str(exc).lower()
        transient = any(
            marker in message
            for marker in ("service error", "temporar", "rate limit", "try again")
        )
        if not transient:
            raise
        logger.warning("shopify — %s: transient error, retrying", name)
        time.sleep(0.25)
        try:
            response = client.post(
                SHOPIFY_CATALOG_URL,
                json=body,
                headers={"Accept": "application/json", "Content-Type": "application/json"},
                timeout=timeout,
            )
            response.raise_for_status()
            products = _extract_products(response.json())
        except (requests.RequestException, ValueError) as retry_exc:
            raise ShopifyCatalogError(
                f"Shopify Global Catalog retry failed: {retry_exc}"
            ) from retry_exc
    candidates = [normalize_product(product) for product in products]
    kept = [candidate for candidate in candidates if candidate is not None][:limit]
    logger.info("shopify — %s: %s products", name, len(kept))
    # #region agent log
    agent_log(
        "C",
        "shopify_filter.py:search",
        "shopify catalog results",
        {
            "category": name,
            "query": query[:120],
            "hasChip": bool(chip_base64),
            "rawProducts": len(products),
            "normalized": len(kept),
            "droppedNormalize": len(products) - len(kept),
            "titles": [c.get("title") for c in kept],
            "prices": [c.get("price") for c in kept],
            "hasUrl": [bool(c.get("url")) for c in kept],
            "hasImage": [bool(c.get("image_url")) for c in kept],
        },
    )
    # #endregion
    return kept


def filter_shopify_products(product_candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Backward-compatible normalizer for the original service stub."""
    normalized = [normalize_product(candidate) for candidate in product_candidates]
    return [candidate for candidate in normalized if candidate is not None]
