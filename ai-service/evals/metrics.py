"""Golden-set matching metrics: garment Jaccard, top-1 URL stability, exact rate."""

from __future__ import annotations

from typing import Any
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

EXACT_VISUAL_THRESHOLD = 0.82
TRACKING_PARAMS = frozenset(
    {
        "utm_source",
        "utm_medium",
        "utm_campaign",
        "utm_term",
        "utm_content",
        "fbclid",
        "gclid",
        "si",
    }
)


def canonical_url(url: str) -> str:
    parsed = urlparse(str(url or "").strip())
    if not parsed.scheme or not parsed.netloc:
        return str(url or "").strip()
    query = [
        (key, value)
        for key, value in parse_qsl(parsed.query, keep_blank_values=True)
        if key.lower() not in TRACKING_PARAMS
    ]
    path = parsed.path.rstrip("/") or "/"
    return urlunparse((parsed.scheme.lower(), parsed.netloc.lower(), path, "", urlencode(query), ""))


def garment_ids(result: dict[str, Any]) -> set[str]:
    ids: set[str] = set()
    for item in result.get("items") or []:
        garment = item.get("garment") or {}
        ident = garment.get("id") or garment.get("category")
        if ident:
            ids.add(str(ident))
    return ids


def jaccard(left: set[str], right: set[str]) -> float:
    if not left and not right:
        return 1.0
    union = left | right
    return len(left & right) / len(union)


def pairwise_jaccard(runs: list[dict[str, Any]]) -> float:
    if not runs:
        return 1.0
    sets = [garment_ids(run) for run in runs]
    scores = [jaccard(sets[i], sets[j]) for i in range(len(sets)) for j in range(i + 1, len(sets))]
    return min(scores) if scores else 1.0


def top_urls_by_garment(result: dict[str, Any]) -> dict[str, str]:
    out: dict[str, str] = {}
    for item in result.get("items") or []:
        garment = item.get("garment") or {}
        ident = str(garment.get("id") or garment.get("category") or "")
        matches = item.get("matches") or []
        if not ident or not matches:
            continue
        out[ident] = canonical_url(str(matches[0].get("url") or ""))
    return out


def top_url_stable(runs: list[dict[str, Any]]) -> bool:
    if len(runs) < 2:
        return True
    first = top_urls_by_garment(runs[0])
    return all(top_urls_by_garment(run) == first for run in runs[1:])


def exact_count(result: dict[str, Any]) -> int:
    count = 0
    for item in result.get("items") or []:
        for match in item.get("matches") or []:
            if match.get("match_type") == "exact":
                count += 1
    return count


def best_visual(result: dict[str, Any]) -> float | None:
    best: float | None = None
    for item in result.get("items") or []:
        for match in item.get("matches") or []:
            try:
                score = float(match.get("visual_score"))
            except (TypeError, ValueError):
                continue
            best = score if best is None else max(best, score)
    return best


def seechip_query_count(result: dict[str, Any]) -> int:
    count = 0
    for item in result.get("items") or []:
        garment = item.get("garment") or {}
        queries = [q for q in (garment.get("queries") or []) if q]
        if queries or garment.get("search_query"):
            count += 1
    return count


def diagnose_fail_stage(result: dict[str, Any]) -> str | None:
    """Name the step that blocked exact when the golden set has no Found cards."""
    empty_reason = result.get("empty_reason")
    media_type = result.get("media_type") or result.get("media")
    if empty_reason == "ingest":
        return "ingest"
    if empty_reason == "see" and media_type == "video":
        return "see"
    items = result.get("items") or []
    if not items:
        return None
    if exact_count(result) > 0:
        return None
    queries = seechip_query_count(result)
    hits = sum(len(item.get("matches") or []) for item in items)
    visual = best_visual(result)
    if queries == 0:
        return "seechip"
    if hits == 0:
        return "retrieve"
    if visual is None or visual < EXACT_VISUAL_THRESHOLD:
        return "judge"
    return "rank"


def score_case(case: dict[str, Any], runs: list[dict[str, Any]]) -> dict[str, Any]:
    jacc = pairwise_jaccard(runs)
    stable = top_url_stable(runs)
    last = runs[-1] if runs else {}
    garments = len(last.get("items") or [])
    exact = exact_count(last)
    fail = diagnose_fail_stage(last)
    empty_ok = bool(case.get("expect_empty"))
    stable_ok = jacc == 1.0 and (empty_ok or stable)
    return {
        "id": case.get("id"),
        "kind": case.get("kind"),
        "runs": len(runs),
        "jaccard": jacc,
        "top_url_stable": stable if not empty_ok else True,
        "garment_count": garments,
        "exact_count": exact,
        "exact_rate": (1.0 if exact else 0.0) if garments else (1.0 if empty_ok else 0.0),
        "visual_score": best_visual(last),
        "fail_stage": fail,
        "ok": stable_ok and (empty_ok == (garments == 0)),
    }


def summarize(rows: list[dict[str, Any]]) -> dict[str, Any]:
    clothed = [row for row in rows if not (row.get("garment_count") == 0)]
    exact_hits = sum(1 for row in clothed if row.get("exact_count", 0) > 0)
    exact_rate = (exact_hits / len(clothed)) if clothed else 0.0
    fail_stages = sorted({row["fail_stage"] for row in rows if row.get("fail_stage")})
    return {
        "cases": len(rows),
        "stable_cases": sum(1 for row in rows if row.get("ok")),
        "exact_rate": round(exact_rate, 3),
        "fail_stages": fail_stages,
        "zero_exact": exact_rate == 0 and bool(clothed),
    }
