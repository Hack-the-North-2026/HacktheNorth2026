"""Stage D retrieval fan-out: multi-query Shopify + optional Composio."""

from __future__ import annotations

import asyncio
import logging
import os
import threading
import time
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

from logging_config import agent_log, garment_name
from services.composio_shopping import composio_configured, composio_mode, search_composio_shopping
from services.query_normalize import garment_catalog_queries, like_query
from services.shopify_filter import ShopifyCatalogError, search_shopify_catalog


logger = logging.getLogger("fit_stealer.retrieval")

SOURCE_BUDGET_S = float(os.getenv("SOURCE_BUDGET_S", "20"))
SHOPIFY_REQUEST_TIMEOUT_S = float(os.getenv("SHOPIFY_REQUEST_TIMEOUT_S", "12"))
SHOPIFY_THIN_THRESHOLD = int(os.getenv("SHOPIFY_THIN_THRESHOLD", "4"))
MAX_RETRIEVED = 16
TRACKING_PARAMS = frozenset(
    {
        "utm_source",
        "utm_medium",
        "utm_campaign",
        "utm_term",
        "utm_content",
        "fbclid",
        "gclid",
        "mc_cid",
        "mc_eid",
        "igshid",
        "si",
    }
)


def canonical_product_url(url: str) -> str:
    """Host + path + non-tracking query, so the same SKU collapses across searches."""
    parsed = urlparse(str(url or "").strip())
    if not parsed.scheme or not parsed.netloc:
        return str(url or "").strip()
    query = [
        (key, value)
        for key, value in parse_qsl(parsed.query, keep_blank_values=True)
        if key.lower() not in TRACKING_PARAMS
    ]
    path = parsed.path.rstrip("/") or "/"
    return urlunparse(
        (parsed.scheme.lower(), parsed.netloc.lower(), path, "", urlencode(query), "")
    )


def dedupe_candidates(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep first hit per canonical URL. Shopify wins over Composio on a tie."""
    ranked = sorted(
        enumerate(candidates),
        key=lambda item: (0 if item[1].get("source") == "shopify" else 1, item[0]),
    )
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for _index, candidate in ranked:
        url = canonical_product_url(str(candidate.get("url") or ""))
        if not url or url in seen:
            continue
        seen.add(url)
        out.append(candidate)
    return out


def prefer_judgeable(candidates: list[dict[str, Any]], limit: int = MAX_RETRIEVED) -> list[dict[str, Any]]:
    """Product photos first so VisualJudge actually has pixels to compare."""
    with_image = [item for item in candidates if item.get("image_url")]
    without = [item for item in candidates if not item.get("image_url")]
    return (with_image + without)[: max(1, limit)]


def shopify_search_jobs(garment: dict[str, Any], chip_base64: str | None) -> list[dict[str, Any]]:
    """At most 3 catalog searches: primary text, distinctive text, like + short query."""
    queries = garment_catalog_queries(garment)
    if not queries:
        return []
    primary = queries[0]
    jobs: list[dict[str, Any]] = [{"kind": "primary", "query": primary, "use_like": False}]
    if len(queries) > 1:
        jobs.append({"kind": "distinctive", "query": queries[1], "use_like": False})
    if chip_base64:
        jobs.append(
            {
                "kind": "like",
                "query": like_query(garment, primary) or primary,
                "use_like": True,
            }
        )
    elif len(queries) > 2:
        jobs.append({"kind": "brand", "query": queries[2], "use_like": False})
    return jobs[:3]


def _run_async(coro):
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    box: dict[str, Any] = {}

    def _runner() -> None:
        try:
            box["value"] = asyncio.run(coro)
        except BaseException as exc:  # noqa: BLE001 — re-raise after join
            box["error"] = exc

    thread = threading.Thread(target=_runner, daemon=True)
    thread.start()
    thread.join()
    if "error" in box:
        raise box["error"]
    return box.get("value")


async def _search_shopify_job(
    job: dict[str, Any],
    garment: dict[str, Any],
    chip_base64: str | None,
    timeout: float,
) -> list[dict[str, Any]]:
    chip = chip_base64 if job.get("use_like") else None
    try:
        return await asyncio.wait_for(
            asyncio.to_thread(
                search_shopify_catalog,
                garment,
                chip,
                query=job["query"],
                use_like=bool(job.get("use_like")),
                timeout=timeout,
            ),
            timeout=timeout + 1.0,
        )
    except (ShopifyCatalogError, ValueError, asyncio.TimeoutError) as exc:
        logger.warning(
            "shopify — %s %s: %s",
            job.get("kind") or "search",
            garment_name(garment),
            exc,
        )
        return []
    except Exception as exc:
        logger.warning(
            "shopify — %s %s: %s",
            job.get("kind") or "search",
            garment_name(garment),
            exc,
        )
        return []


async def fanout_shopify_async(
    garment: dict[str, Any],
    chip_base64: str | None,
    *,
    budget_s: float = SOURCE_BUDGET_S,
) -> list[dict[str, Any]]:
    jobs = shopify_search_jobs(garment, chip_base64)
    if not jobs:
        return []
    per_request = min(SHOPIFY_REQUEST_TIMEOUT_S, max(4.0, budget_s - 1.0))
    tasks = [
        asyncio.create_task(_search_shopify_job(job, garment, chip_base64, per_request))
        for job in jobs
    ]
    done, pending = await asyncio.wait(tasks, timeout=max(1.0, budget_s))
    for task in pending:
        task.cancel()
    if pending:
        await asyncio.gather(*pending, return_exceptions=True)
    hits: list[dict[str, Any]] = []
    for task in done:
        try:
            hits.extend(task.result() or [])
        except Exception:
            logger.exception("shopify — %s: fan-out task failed", garment_name(garment))
    return hits


def fanout_shopify(
    garment: dict[str, Any],
    chip_base64: str | None,
    *,
    budget_s: float = SOURCE_BUDGET_S,
) -> list[dict[str, Any]]:
    """Run 2–3 Shopify searches in parallel and return the raw (possibly duplicate) hits."""
    return _run_async(fanout_shopify_async(garment, chip_base64, budget_s=budget_s)) or []


def retrieve_candidates(
    garment: dict[str, Any],
    chip_base64: str | None = None,
    *,
    budget_s: float = SOURCE_BUDGET_S,
) -> list[dict[str, Any]]:
    """Shopify fan-out, URL dedup, then Composio if the catalog slice is thin."""
    name = garment_name(garment)
    queries = garment_catalog_queries(garment)
    jobs = shopify_search_jobs(garment, chip_base64)
    started = time.monotonic()
    shopify_hits = fanout_shopify(garment, chip_base64, budget_s=budget_s)
    elapsed = time.monotonic() - started
    unique = dedupe_candidates(shopify_hits)
    thin = len(unique) < SHOPIFY_THIN_THRESHOLD
    composio_hits: list[dict[str, Any]] = []
    mode = composio_mode()
    remaining = max(0.0, budget_s - elapsed)
    should_shop = composio_configured() and (thin or mode == "always") and remaining >= 2.0
    if should_shop:
        shop_queries = queries[:2] or ([queries[0]] if queries else [])
        per_timeout = min(8.0, remaining / max(1, len(shop_queries)))
        for query in shop_queries:
            if time.monotonic() - started >= budget_s - 1.0:
                break
            composio_hits.extend(
                search_composio_shopping(
                    garment,
                    query=query,
                    timeout=per_timeout,
                )
            )
        unique = dedupe_candidates(unique + composio_hits)
    selected = prefer_judgeable(unique)
    logger.info(
        "source — %s: %s shopify hits → %s unique%s",
        name,
        len(shopify_hits),
        len(unique),
        f", +{len(composio_hits)} composio" if composio_hits else "",
    )
    agent_log(
        "D",
        "retrieval.py:retrieve",
        "retrieval fan-out",
        {
            "category": name,
            "queries": [job["query"] for job in jobs],
            "kinds": [job["kind"] for job in jobs],
            "shopifyRaw": len(shopify_hits),
            "unique": len(unique),
            "thin": thin,
            "composioMode": mode,
            "composioHits": len(composio_hits),
            "selected": len(selected),
            "sources": [item.get("source") for item in selected],
        },
    )
    return selected
