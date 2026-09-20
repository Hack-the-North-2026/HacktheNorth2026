"""OpenAI product ranker for honest exact-versus-similar claims."""

from __future__ import annotations

import json
import logging
import os
import re
from typing import TYPE_CHECKING, Any

from logging_config import agent_log, garment_name
from services.visual_judge import EXACT_VISUAL_THRESHOLD

if TYPE_CHECKING:
    from openai import OpenAI

logger = logging.getLogger("fit_stealer.rank")

DEMOTED_REASON = "Similar look, but the product photo does not confirm it is the same item."

CATEGORY_ALIASES: dict[str, set[str]] = {
    "jacket": {
        "jacket", "bomber", "coat", "blazer", "parka", "anorak",
        "windbreaker", "overshirt", "shacket", "field", "biker",
    },
    "shirt": {
        "shirt", "tee", "t-shirt", "tshirt", "top", "blouse", "polo",
        "sweater", "knit", "hoodie", "crewneck", "pullover", "cardigan",
    },
    "pants": {"pants", "trousers", "jeans", "chinos", "joggers", "sweatpants"},
    "shorts": {"shorts", "short"},
    "skirt": {"skirt", "skort"},
    "dress": {"dress", "gown"},
    "shoes": {
        "shoes", "shoe", "sneaker", "sneakers", "boot", "boots",
        "loafer", "loafers", "sandal", "sandals",
    },
    "bag": {"bag", "tote", "backpack", "crossbody", "purse", "handbag"},
    "hat": {"hat", "cap", "beanie", "beret"},
    "accessory": {
        "scarf", "belt", "necklace", "jewelry", "watch", "glasses",
        "sunglasses", "accessory",
    },
}


_RANK_SCHEMA = {
    "type": "json_schema",
    "json_schema": {
        "name": "ProductRanking",
        "strict": True,
        "schema": {
            "type": "object",
            "properties": {
                "matches": {
                    "type": "array",
                    "maxItems": 3,
                    "items": {
                        "type": "object",
                        "properties": {
                            "candidate_index": {"type": "integer"},
                            "match_type": {
                                "type": "string",
                                "enum": ["exact", "similar"],
                            },
                            "confidence": {"type": "number"},
                            "reason": {"type": "string"},
                        },
                        "required": [
                            "candidate_index", "match_type", "confidence", "reason"
                        ],
                        "additionalProperties": False,
                    },
                }
            },
            "required": ["matches"],
            "additionalProperties": False,
        },
    },
}


_SYSTEM_PROMPT = """You rank commerce candidates against one visibly detected garment.

Each candidate may include visual_score (0-1) and visual_label (same_item|similar|different)
from a vision model that compared the garment chip to the product photo.

Return at most three strong matches. Drop weak matches completely.
- exact: ONLY if visual_score >= 0.82 AND visual_label is same_item AND category/silhouette agree.
  Never exact from title overlap, store name, or brand guess.
- similar: same category with a convincing color, material, pattern, and silhouette match.
- If visual_score is missing or below 0.82, you MUST choose similar or drop. Never exact.
- Never promote a similar item to exact.
- Never infer garment brand from store_name or candidate title alone.
- If garment.brand is null or brand_cues is empty, do not claim brand agreement.
- candidate_index must refer to the supplied candidate list.
- confidence is 0 to 1. reason is one short, user-facing sentence.
"""


def _words(value: Any) -> set[str]:
    return set(re.findall(r"[a-z0-9]+", str(value).lower()))


def category_agrees(garment: dict[str, Any], candidate: dict[str, Any]) -> bool:
    """True when the product title is compatible with the detected category."""
    category = str(garment.get("category") or "").lower().strip()
    title = str(candidate.get("title") or "").lower()
    if not category:
        return True
    aliases = CATEGORY_ALIASES.get(category, {category})
    if not title:
        return True
    return any(alias in title for alias in aliases)


def _visual_map(visual_scores: list[dict[str, Any]] | None) -> dict[int, dict[str, Any]]:
    mapped: dict[int, dict[str, Any]] = {}
    for row in visual_scores or []:
        index = row.get("candidate_index")
        if isinstance(index, int):
            mapped[index] = row
    return mapped


def _gate_exact(
    match_type: str,
    candidate: dict[str, Any],
    garment: dict[str, Any],
    visual: dict[str, Any] | None,
) -> tuple[str, str | None]:
    """Demote exact unless the chip was visually compared and scored high."""
    if match_type != "exact":
        return match_type, None
    score = None
    label = None
    if visual:
        try:
            score = float(visual.get("score"))
        except (TypeError, ValueError):
            score = None
        label = visual.get("label")
    if (
        score is None
        or score < EXACT_VISUAL_THRESHOLD
        or label == "different"
        or not category_agrees(garment, candidate)
    ):
        return "similar", DEMOTED_REASON
    return "exact", None


def fallback_rank_candidates(
    garment: dict[str, Any], candidates: list[dict[str, Any]], max_matches: int = 3
) -> list[dict[str, Any]]:
    """Conservative local fallback: token overlap, always labelled similar."""
    name = garment_name(garment)
    logger.info("rank — %s: using local similar-only fallback", name)
    garment_terms = _words(
        " ".join(
            [
                str(garment.get("category", "")),
                str(garment.get("description", "")),
                str(garment.get("search_query", "")),
                json.dumps(garment.get("attributes", {})),
            ]
        )
    )
    scored: list[tuple[float, dict[str, Any]]] = []
    for candidate in candidates:
        title_terms = _words(candidate.get("title", ""))
        overlap = len(garment_terms & title_terms)
        score = overlap / max(1, len(title_terms))
        if overlap == 0:
            continue
        match = dict(candidate)
        match.update(
            {
                "match_type": "similar",
                "confidence": round(min(0.74, 0.4 + score * 0.4), 2),
                "reason": "Similar category and visible style details.",
            }
        )
        scored.append((score, match))
    scored.sort(key=lambda pair: pair[0], reverse=True)
    return [match for _, match in scored[:max_matches]]


def rank_candidates(
    garment: dict[str, Any],
    candidates: list[dict[str, Any]],
    *,
    client: "OpenAI | None" = None,
    model: str | None = None,
    max_matches: int = 3,
    visual_scores: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Ask OpenAI to select indexes, then join trusted product data locally."""
    name = garment_name(garment)
    if not candidates:
        logger.info("rank — %s: skipped, no Shopify products to rank", name)
        return []
    if client is None:
        api_key = os.getenv("OPENAI_API_KEY", "")
        if not api_key:
            raise ValueError("OPENAI_API_KEY is not set")
        from openai import OpenAI

        client = OpenAI(api_key=api_key)
    visuals = _visual_map(visual_scores)
    logger.info(
        "rank — %s: asking OpenAI to pick matches from %s products (%s visual scores)",
        name,
        len(candidates),
        len(visuals),
    )
    safe_garment = {
        key: garment.get(key)
        for key in (
            "category",
            "description",
            "search_query",
            "attributes",
            "brand",
            "brand_cues",
        )
    }
    safe_candidates = []
    for index, item in enumerate(candidates):
        row = {
            "candidate_index": index,
            "title": item.get("title", ""),
            "store_name": item.get("store_name"),
            "price": item.get("price"),
            "currency": item.get("currency"),
        }
        visual = visuals.get(index)
        if visual:
            row["visual_score"] = visual.get("score")
            row["visual_label"] = visual.get("label")
            row["visual_reason"] = visual.get("reason")
        safe_candidates.append(row)
    user_payload = {"garment": safe_garment, "candidates": safe_candidates}
    completion = client.chat.completions.create(
        model=model or os.getenv("OPENAI_RANK_MODEL", "gpt-4.1-mini"),
        messages=[
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user", "content": json.dumps(user_payload)},
        ],
        response_format=_RANK_SCHEMA,
        temperature=0,
        seed=0,
    )
    content = completion.choices[0].message.content
    ranking = json.loads(content or '{"matches": []}')
    output: list[dict[str, Any]] = []
    seen: set[int] = set()
    for selection in ranking.get("matches", []):
        index = selection.get("candidate_index")
        if not isinstance(index, int) or index < 0 or index >= len(candidates) or index in seen:
            continue
        confidence = max(0.0, min(1.0, float(selection.get("confidence", 0))))
        reason = str(selection.get("reason", "")).strip()
        if not reason:
            continue
        visual = visuals.get(index)
        match_type, demoted_reason = _gate_exact(
            selection["match_type"], candidates[index], garment, visual
        )
        if demoted_reason:
            reason = demoted_reason
            confidence = min(confidence, 0.74)
        match = dict(candidates[index])
        match.update(
            {
                "match_type": match_type,
                "confidence": confidence,
                "reason": reason,
            }
        )
        if visual:
            match["visual_score"] = visual.get("score")
            match["visual_label"] = visual.get("label")
        output.append(match)
        seen.add(index)
        if len(output) >= min(3, max(1, max_matches)):
            break
    exact = sum(1 for match in output if match.get("match_type") == "exact")
    similar = sum(1 for match in output if match.get("match_type") == "similar")
    best = max(
        (float(match["visual_score"]) for match in output if match.get("visual_score") is not None),
        default=None,
    )
    logger.info(
        "rank — %s: kept %s exact, %s similar (best visual %s)",
        name,
        exact,
        similar,
        f"{best:.2f}" if isinstance(best, float) else "none",
    )
    # #region agent log
    agent_log(
        "E",
        "product_ranker.py:rank",
        "ranked matches",
        {
            "category": name,
            "candidateCount": len(candidates),
            "kept": len(output),
            "exact": exact,
            "similar": similar,
            "bestVisual": best,
            "garmentBrand": garment.get("brand"),
            "garmentQuery": str(garment.get("search_query") or "")[:120],
            "matches": [
                {
                    "title": m.get("title"),
                    "match_type": m.get("match_type"),
                    "confidence": m.get("confidence"),
                    "visual_score": m.get("visual_score"),
                    "visual_label": m.get("visual_label"),
                    "reason": m.get("reason"),
                    "store_name": m.get("store_name"),
                }
                for m in output
            ],
        },
    )
    # #endregion
    return output
