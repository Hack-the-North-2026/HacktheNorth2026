"""OpenAI product ranker for honest exact-versus-similar claims."""

from __future__ import annotations

import json
import os
import re
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from openai import OpenAI


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

Return at most three strong matches. Drop weak matches completely.
- exact: only the same item/SKU, supported by unusually specific visual or legible brand evidence.
- similar: same category with a convincing color, material, pattern, and silhouette match.
- Never promote a similar item to exact.
- Never infer garment brand from store_name or candidate title alone.
- If garment.brand is null or brand_cues is empty, do not claim brand agreement.
- candidate_index must refer to the supplied candidate list.
- confidence is 0 to 1. reason is one short, user-facing sentence.
"""


def _words(value: Any) -> set[str]:
    return set(re.findall(r"[a-z0-9]+", str(value).lower()))


def fallback_rank_candidates(
    garment: dict[str, Any], candidates: list[dict[str, Any]], max_matches: int = 3
) -> list[dict[str, Any]]:
    """Conservative local fallback: token overlap, always labelled similar."""
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
) -> list[dict[str, Any]]:
    """Ask OpenAI to select indexes, then join trusted product data locally."""
    if not candidates:
        return []
    if client is None:
        api_key = os.getenv("OPENAI_API_KEY", "")
        if not api_key:
            raise ValueError("OPENAI_API_KEY is not set")
        from openai import OpenAI

        client = OpenAI(api_key=api_key)
    safe_candidates = [
        {
            "candidate_index": index,
            "title": item.get("title", ""),
            "store_name": item.get("store_name"),
            "price": item.get("price"),
            "currency": item.get("currency"),
        }
        for index, item in enumerate(candidates)
    ]
    user_payload = {"garment": garment, "candidates": safe_candidates}
    completion = client.chat.completions.create(
        model=model or os.getenv("OPENAI_RANK_MODEL", "gpt-4.1-mini"),
        messages=[
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user", "content": json.dumps(user_payload)},
        ],
        response_format=_RANK_SCHEMA,
        temperature=0,
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
        match = dict(candidates[index])
        match.update(
            {
                "match_type": selection["match_type"],
                "confidence": confidence,
                "reason": reason,
            }
        )
        output.append(match)
        seen.add(index)
        if len(output) >= min(3, max(1, max_matches)):
            break
    return output
