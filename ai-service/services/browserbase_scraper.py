"""Browserbase reverse-image / shopping extract for Stage E.

Triggered only when VisualJudge is weak or the catalog is empty. Hard 15s
cap, 1–2 pages. Stagehand `extract()` when available; Playwright DOM scrape
otherwise. Listings keep ``source: browserbase`` and go through VisualJudge.
"""

from __future__ import annotations

import logging
import os
import re
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FuturesTimeout
from pathlib import Path
from typing import Any
from urllib.parse import quote_plus, urlparse

import requests

from logging_config import agent_log, garment_name
from services.query_normalize import garment_catalog_queries
from services.visual_judge import WEAK_VISUAL_THRESHOLD, best_visual_score, chip_jpeg_bytes


logger = logging.getLogger("fit_stealer.browserbase")

BROWSERBASE_SESSIONS_URL = "https://api.browserbase.com/v1/sessions"
BROWSERBASE_PROJECTS_URL = "https://api.browserbase.com/v1/projects"
BROWSE_TIMEOUT_S = float(os.getenv("BROWSERBASE_TIMEOUT_S", "15"))
REVERSE_IMAGE_BUDGET_S = 5.0
SHOPPING_RESERVE_S = 5.0
MAX_PAGES = 2
MAX_PRODUCTS = 6
_BROWSE_GATE = threading.Semaphore(max(1, int(os.getenv("BROWSERBASE_CONCURRENCY", "2"))))
_PROJECT_ID_CACHE: str | None = None

_SKIP_HOSTS = (
    "accounts.google.",
    "gstatic.com",
    "googleusercontent.com",
    "youtube.com",
    "facebook.com",
    "instagram.com",
    "tiktok.com",
    "twitter.com",
    "x.com",
    "microsoftonline.com",
    "login.live.com",
)

_EXTRACT_SCHEMA = {
    "type": "object",
    "properties": {
        "products": {
            "type": "array",
            "maxItems": 6,
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "url": {"type": "string"},
                    "image_url": {"type": "string"},
                    "price": {"type": "string"},
                    "store_name": {"type": "string"},
                },
                "required": ["title", "url"],
            },
        }
    },
    "required": ["products"],
}

_EXTRACT_JS = """() => {
  const skipHost = /accounts\\.google|gstatic\\.com|googleusercontent|youtube\\.com|facebook\\.com|instagram\\.com/;
  const usefulHref = /shopping\\/product|\\/listings?\\/|\\/products?\\/|ssense\\.com|grailed\\.com|farfetch|depop|therealreal|stockx|ebay\\.com|\\/shop\\//;
  const seen = new Set();
  const out = [];
  const push = (title, href, img, price, store) => {
    if (!href || !href.startsWith("http") || seen.has(href) || skipHost.test(href)) return;
    const clean = (title || "").split("\\n").map((s) => s.trim()).filter((t) => t && t.length > 3 && t.length < 180)[0];
    if (!clean) return;
    seen.add(href);
    out.push({
      title: clean,
      url: href,
      image_url: img || "",
      price: price || "",
      store_name: store || "",
    });
  };
  const anchors = Array.from(document.querySelectorAll("a[href]"));
  for (const a of anchors) {
    const href = a.href || "";
    const text = (a.getAttribute("aria-label") || a.innerText || "").trim();
    const img = a.querySelector("img");
    const imgSrc = img && (img.src || img.getAttribute("src") || "");
    const lines = text.split("\\n").map((s) => s.trim()).filter(Boolean);
    const price = (text.match(/(?:CA\\$|C\\$|US\\$|\\$|£|€)\\s?[\\d,.]+/) || [])[0] || "";
    const title = lines.find((t) => t !== price && !/^(sponsored|ad)$/i.test(t)) || "";
    const store = lines.find((t) => t !== title && t !== price && t.length < 48) || "";
    const useful = usefulHref.test(href) || (Boolean(price) && Boolean(imgSrc));
    if (useful) push(title, href, imgSrc, price, store);
    if (out.length >= 8) break;
  }
  return out;
}"""


class BrowserbaseSearchError(RuntimeError):
    """A recoverable Browserbase session or extract failure."""


def browserbase_mode() -> str:
    raw = os.getenv("BROWSERBASE", os.getenv("BROWSERBASE_SEARCH", "auto")).strip().lower()
    if raw in {"0", "off", "false", "no"}:
        return "off"
    if raw in {"always", "1", "on", "true"}:
        return "always"
    return "auto"


def browserbase_configured() -> bool:
    return bool(os.getenv("BROWSERBASE_API_KEY", "").strip()) and browserbase_mode() != "off"


def weak_visual_threshold() -> float:
    try:
        return float(os.getenv("BROWSERBASE_WEAK_SCORE", str(WEAK_VISUAL_THRESHOLD)))
    except ValueError:
        return WEAK_VISUAL_THRESHOLD


def should_browse(
    visual_scores: list[dict[str, Any]] | None,
    candidates: list[dict[str, Any]] | None = None,
) -> bool:
    """Reverse-image only when the catalog visual evidence is weak or missing."""
    if not browserbase_configured():
        return False
    if browserbase_mode() == "always":
        return True
    if not candidates:
        return True
    best = best_visual_score(visual_scores)
    if best is None:
        return True
    return best < weak_visual_threshold()


def _headers(api_key: str) -> dict[str, str]:
    return {"X-BB-API-Key": api_key, "Content-Type": "application/json"}


def _project_id(api_key: str) -> str | None:
    global _PROJECT_ID_CACHE
    env = os.getenv("BROWSERBASE_PROJECT_ID", "").strip()
    if env:
        return env
    if _PROJECT_ID_CACHE:
        return _PROJECT_ID_CACHE
    try:
        response = requests.get(BROWSERBASE_PROJECTS_URL, headers=_headers(api_key), timeout=8)
        response.raise_for_status()
        payload = response.json()
    except (requests.RequestException, ValueError):
        return None
    rows = payload if isinstance(payload, list) else payload.get("data") or payload.get("projects") or []
    for row in rows:
        if isinstance(row, dict) and row.get("id"):
            _PROJECT_ID_CACHE = str(row["id"])
            return _PROJECT_ID_CACHE
    return None


def _create_session(api_key: str, timeout_s: float) -> tuple[str, str]:
    body: dict[str, Any] = {}
    project = _project_id(api_key)
    if project:
        body["projectId"] = project
    try:
        body["timeout"] = max(60, int(timeout_s + 15))
    except (TypeError, ValueError):
        pass
    response = requests.post(
        BROWSERBASE_SESSIONS_URL,
        headers=_headers(api_key),
        json=body,
        timeout=10,
    )
    response.raise_for_status()
    payload = response.json()
    session_id = str(payload.get("id") or "")
    connect = str(payload.get("connectUrl") or payload.get("connect_url") or "")
    if not session_id or not connect:
        raise BrowserbaseSearchError("Browserbase session missing connectUrl")
    return session_id, connect


def _end_session(api_key: str, session_id: str) -> None:
    if not session_id:
        return
    try:
        requests.post(
            f"{BROWSERBASE_SESSIONS_URL}/{session_id}/request-release",
            headers=_headers(api_key),
            timeout=5,
        )
    except requests.RequestException:
        try:
            requests.delete(
                f"{BROWSERBASE_SESSIONS_URL}/{session_id}",
                headers=_headers(api_key),
                timeout=5,
            )
        except requests.RequestException:
            pass


def _is_dead_result_page(url: str) -> bool:
    """Bing/Lens often land on marketing or consent URLs with no product cards."""
    parsed = urlparse(str(url or ""))
    host = parsed.netloc.lower()
    path = parsed.path.lower()
    if "explore.microsoft.com" in host:
        return True
    if "bing.com" in host and "images/search" not in path and "shop" not in path and "visualsearch" not in path:
        return True
    return False


def _usable_url(url: str) -> bool:
    if not isinstance(url, str) or not url.startswith(("https://", "http://")):
        return False
    host = urlparse(url).netloc.lower()
    if any(marker in host for marker in _SKIP_HOSTS):
        return False
    if "google." in host and "shopping" not in url and "/product" not in url:
        return False
    if "bing.com" in host and "shopping" not in url:
        return False
    return True


def _parse_price(raw: str | None) -> tuple[str | None, str | None]:
    if not raw:
        return None, None
    text = str(raw)
    currency = None
    if "CAD" in text.upper() or "C$" in text:
        currency = "CAD"
    elif "£" in text or "GBP" in text.upper():
        currency = "GBP"
    elif "€" in text:
        currency = "EUR"
    elif "$" in text or "USD" in text.upper():
        currency = "USD"
    digits = re.sub(r"[^\d.]", "", text.replace(",", ""))
    try:
        return f"{float(digits):.2f}", currency
    except ValueError:
        return None, currency


def normalize_browserbase_product(item: dict[str, Any]) -> dict[str, Any] | None:
    if not isinstance(item, dict):
        return None
    title = item.get("title") or item.get("name")
    url = item.get("url") or item.get("link") or item.get("product_url")
    if not isinstance(title, str) or not _usable_url(str(url or "")):
        return None
    candidate: dict[str, Any] = {
        "title": title.strip()[:200],
        "url": str(url),
        "source": "browserbase",
    }
    image = item.get("image_url") or item.get("image") or item.get("thumbnail")
    if isinstance(image, str) and image.startswith(("https://", "http://")):
        candidate["image_url"] = image
    price, currency = _parse_price(item.get("price") if isinstance(item.get("price"), str) else None)
    if price:
        candidate["price"] = price
    if currency:
        candidate["currency"] = currency
    store = item.get("store_name") or item.get("source") or item.get("merchant")
    if isinstance(store, str) and store.strip() and store.strip().lower() not in {"google", "bing", "browserbase"}:
        candidate["store_name"] = store.strip()[:80]
    host = urlparse(candidate["url"]).netloc.lower().removeprefix("www.")
    if host and "store_name" not in candidate:
        candidate["store_name"] = host.split(":")[0]
    return candidate


def _dismiss_consent(page: Any, ms: int = 1500) -> None:
    for label in ("Accept all", "I agree", "Accept", "Got it"):
        try:
            page.get_by_role("button", name=label).first.click(timeout=ms)
            return
        except Exception:
            continue


def _set_file(page: Any, chip_path: str, ms: int = 4000) -> bool:
    try:
        locator = page.locator('input[type="file"]')
        if locator.count() > 0:
            locator.first.set_input_files(chip_path, timeout=ms)
            return True
    except Exception:
        pass
    try:
        with page.expect_file_chooser(timeout=ms) as chooser:
            for sel in (
                '[aria-label="Search by image"]',
                'div[aria-label*="image"]',
                'input[type="file"]',
            ):
                try:
                    page.locator(sel).first.click(timeout=800)
                    break
                except Exception:
                    continue
        chooser.value.set_files(chip_path)
        return True
    except Exception:
        return False


def _dom_extract(page: Any) -> list[dict[str, Any]]:
    try:
        raw = page.evaluate(_EXTRACT_JS)
    except Exception:
        return []
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for item in raw:
        normalized = normalize_browserbase_product(item) if isinstance(item, dict) else None
        if normalized:
            out.append(normalized)
    return out


def _stagehand_extract(session_id: str, instruction: str) -> list[dict[str, Any]]:
    try:
        from stagehand import Stagehand
    except Exception:
        return []
    api_key = os.getenv("BROWSERBASE_API_KEY", "")
    model_key = os.getenv("MODEL_API_KEY") or os.getenv("OPENAI_API_KEY") or ""
    if not api_key or not model_key:
        return []
    try:
        client = Stagehand(browserbase_api_key=api_key, model_api_key=model_key)
        response = client.sessions.extract(
            session_id,
            instruction=instruction,
            schema=_EXTRACT_SCHEMA,
            options={"timeout": 8000},
        )
        result = getattr(getattr(response, "data", None), "result", None) or {}
        if isinstance(result, dict):
            products = result.get("products") or []
        elif isinstance(result, list):
            products = result
        else:
            products = []
        out = []
        for item in products:
            normalized = normalize_browserbase_product(item) if isinstance(item, dict) else None
            if normalized:
                out.append(normalized)
        return out
    except Exception as exc:
        logger.info("browserbase — Stagehand extract skipped (%s)", str(exc)[:120])
        return []


def _shopping_url(query: str) -> str:
    return (
        "https://www.google.com/search?tbm=shop&hl=en&gl=ca&q="
        + quote_plus(query)
    )


def _grailed_url(query: str) -> str:
    return "https://www.grailed.com/shop?query=" + quote_plus(query)


def _run_browser_search(
    garment: dict[str, Any],
    chip_path: str | None,
    deadline: float,
) -> list[dict[str, Any]]:
    import time as time_mod

    try:
        from playwright.sync_api import sync_playwright
    except Exception as exc:
        raise BrowserbaseSearchError(f"Playwright is not installed: {exc}") from exc

    api_key = os.getenv("BROWSERBASE_API_KEY", "").strip()
    remaining = lambda: deadline - time_mod.monotonic()
    if remaining() < 2:
        return []
    session_id, connect = _create_session(api_key, max(remaining(), 15))
    products: list[dict[str, Any]] = []
    pages_used = 0
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.connect_over_cdp(connect, timeout=8_000)
            context = browser.contexts[0] if browser.contexts else browser.new_context()
            page = context.pages[0] if context.pages else context.new_page()
            page.set_default_timeout(4_000)
            queries = garment_catalog_queries(garment)
            query = queries[0] if queries else str(garment.get("search_query") or garment.get("description") or "")

            def collect(reason: str) -> None:
                url = page.url or ""
                if _is_dead_result_page(url):
                    logger.info(
                        "browserbase — %s %s: skipped dead page %s",
                        garment_name(garment),
                        reason,
                        url[:90],
                    )
                    return
                found = _dom_extract(page)
                if not found and remaining() > SHOPPING_RESERVE_S:
                    found = _stagehand_extract(
                        session_id,
                        "Extract up to 6 clothing product listings with title, url, image_url, price, store_name",
                    )
                logger.info(
                    "browserbase — %s %s: %s hits at %s",
                    garment_name(garment),
                    reason,
                    len(found),
                    url[:90],
                )
                products.extend(found)

            if chip_path and remaining() > SHOPPING_RESERVE_S + 2:
                try:
                    page.goto("https://www.bing.com/visualsearch?FORM=Z9FD1", wait_until="domcontentloaded")
                    _dismiss_consent(page, 800)
                    uploaded = _set_file(page, chip_path, 2500)
                    if not uploaded:
                        page.goto("https://lens.google.com/v3/", wait_until="domcontentloaded")
                        _dismiss_consent(page, 800)
                        uploaded = _set_file(page, chip_path, 2500)
                    if uploaded and remaining() > SHOPPING_RESERVE_S:
                        wait_ms = min(4500, int(max(remaining() - SHOPPING_RESERVE_S, 0.6) * 1000))
                        page.wait_for_timeout(wait_ms)
                        collect("reverse-image")
                        pages_used += 1
                except Exception as exc:
                    logger.info("browserbase — reverse-image page failed (%s)", str(exc)[:120])

            if len(products) < 2 and query and remaining() > 2.5:
                try:
                    page.goto(_shopping_url(query), wait_until="domcontentloaded")
                    _dismiss_consent(page, 800)
                    page.wait_for_timeout(min(1600, int(max(remaining(), 0.4) * 350)))
                    collect("google-shopping")
                    pages_used += 1
                except Exception as exc:
                    logger.info("browserbase — shopping page failed (%s)", str(exc)[:120])

            if len(products) < 2 and query and remaining() > 2.5:
                try:
                    page.goto(_grailed_url(query), wait_until="domcontentloaded")
                    page.wait_for_timeout(min(1400, int(max(remaining(), 0.4) * 350)))
                    collect("grailed")
                    pages_used += 1
                except Exception as exc:
                    logger.info("browserbase — grailed page failed (%s)", str(exc)[:120])

            try:
                browser.close()
            except Exception:
                pass
    finally:
        _end_session(api_key, session_id)

    unique: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in products:
        url = str(item.get("url") or "")
        if url in seen:
            continue
        seen.add(url)
        unique.append(item)
        if len(unique) >= MAX_PRODUCTS:
            break
    logger.info(
        "browserbase — %s: %s products from %s page%s",
        garment_name(garment),
        len(unique),
        pages_used,
        "" if pages_used == 1 else "s",
    )
    return unique


def _write_chip_file(chip: str | Path | bytes | None, garment: dict[str, Any] | None) -> str | None:
    data = chip_jpeg_bytes(chip, garment)
    if not data:
        return None
    handle = tempfile.NamedTemporaryFile(prefix="fit-stealer-bb-", suffix=".jpg", delete=False)
    try:
        handle.write(data)
        handle.flush()
        return handle.name
    finally:
        handle.close()


def search_products_with_browserbase(
    item_description: str | dict[str, Any] | None = None,
    image_url: str | None = None,
    *,
    garment: dict[str, Any] | None = None,
    chip: str | Path | bytes | None = None,
    timeout: float = BROWSE_TIMEOUT_S,
) -> list[dict[str, Any]]:
    """Reverse-image / shopping extract. Empty list if unconfigured, timed out, or failed."""
    if isinstance(item_description, dict) and garment is None:
        garment = item_description
    garment = garment or {
        "category": "item",
        "search_query": str(item_description or ""),
        "description": str(item_description or ""),
        "chip_key": image_url or "",
    }
    name = garment_name(garment)
    if not browserbase_configured():
        return []
    timeout = min(max(float(timeout), 4.0), 20.0)
    chip_path = _write_chip_file(chip, garment)
    logger.info("browserbase — %s: reverse-image / extract (%ss cap)", name, int(timeout))
    acquired = _BROWSE_GATE.acquire(timeout=min(timeout, 8.0))
    if not acquired:
        logger.warning("browserbase — %s: skipped, concurrency gate full", name)
        if chip_path:
            Path(chip_path).unlink(missing_ok=True)
        return []

    def _call() -> list[dict[str, Any]]:
        import time as time_mod

        return _run_browser_search(garment, chip_path, time_mod.monotonic() + timeout)

    products: list[dict[str, Any]] = []
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(_call)
            try:
                products = future.result(timeout=timeout + 1.0)
            except FuturesTimeout:
                logger.warning("browserbase — %s: timed out after %ss", name, int(timeout))
                products = []
            except Exception as exc:
                logger.warning("browserbase — %s: failed (%s)", name, exc)
                agent_log(
                    "E",
                    "browserbase_scraper.py:search",
                    "browserbase failed",
                    {"category": name, "error": str(exc)[:200]},
                )
                products = []
    finally:
        _BROWSE_GATE.release()
        if chip_path:
            Path(chip_path).unlink(missing_ok=True)

    agent_log(
        "E",
        "browserbase_scraper.py:search",
        "browserbase results",
        {
            "category": name,
            "count": len(products),
            "titles": [item.get("title") for item in products],
            "urls": [str(item.get("url") or "")[:120] for item in products],
        },
    )
    return products


def browse_products(
    garment: dict[str, Any],
    chip: str | Path | bytes | None = None,
    *,
    timeout: float = BROWSE_TIMEOUT_S,
) -> list[dict[str, Any]]:
    """Stage E entry used by source_and_rank."""
    return search_products_with_browserbase(garment=garment, chip=chip, timeout=timeout)
