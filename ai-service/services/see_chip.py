"""Chip-first See — Baseten specialist on the isolated garment, OpenAI honesty merge.

Scene See keeps bboxes + outfit_summary. This pass overwrites description,
attributes, brand_cues, and search queries from the padded crop.
"""

from __future__ import annotations

import json
import logging
import os
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

from openai import OpenAI

from logging_config import agent_log, garment_name
from services.baseten_vlm import encode_image_data_uri
from services.cropper import managed_media_path
from services.query_normalize import canonicalize_query, unique_queries

logger = logging.getLogger("fit_stealer.see_chip")

MAX_WORKERS = 4

_ATTRIBUTES_SCHEMA = {
    "type": "object",
    "properties": {
        "color": {"type": "string"},
        "material": {"type": ["string", "null"]},
        "pattern": {"type": ["string", "null"]},
        "fit": {"type": ["string", "null"]},
    },
    "required": ["color", "material", "pattern", "fit"],
    "additionalProperties": False,
}

_CHIP_SCHEMA = {
    "type": "json_schema",
    "json_schema": {
        "name": "ChipGarment",
        "strict": True,
        "schema": {
            "type": "object",
            "properties": {
                "description": {"type": "string"},
                "attributes": _ATTRIBUTES_SCHEMA,
                "brand": {"type": ["string", "null"]},
                "brand_cues": {"type": "array", "items": {"type": "string"}},
                "primary_query": {"type": "string"},
                "distinctive_query": {"type": "string"},
                "brand_query": {"type": ["string", "null"]},
                "accessibility_line": {"type": "string"},
                "confidence": {"type": "number"},
            },
            "required": [
                "description",
                "attributes",
                "brand",
                "brand_cues",
                "primary_query",
                "distinctive_query",
                "brand_query",
                "accessibility_line",
                "confidence",
            ],
            "additionalProperties": False,
        },
    },
}

_MERGE_SCHEMA = {
    "type": "json_schema",
    "json_schema": {
        "name": "GarmentMerge",
        "strict": True,
        "schema": {
            "type": "object",
            "properties": {
                "description": {"type": "string"},
                "attributes": _ATTRIBUTES_SCHEMA,
                "brand": {"type": ["string", "null"]},
                "brand_cues": {"type": "array", "items": {"type": "string"}},
                "search_query": {"type": "string"},
                "queries": {
                    "type": "array",
                    "maxItems": 3,
                    "items": {"type": "string"},
                },
                "accessibility_line": {"type": "string"},
            },
            "required": [
                "description",
                "attributes",
                "brand",
                "brand_cues",
                "search_query",
                "queries",
                "accessibility_line",
            ],
            "additionalProperties": False,
        },
    },
}

_CHIP_SYSTEM = """You are looking at a cropped close-up of ONE garment.

Describe only this item. Ignore people, faces, and background.

Rules:
1. brand MUST be null unless a logo, label, or clothing tag is CLEARLY and LEGIBLY readable in this crop. Never guess from style.
2. brand_cues: quote the readable logo/tag text. Empty array if nothing is legible.
3. description must name specific visible details: color, material, silhouette, hardware, wash, knit, stitching.
   Good: "black leather bomber with silver zip hardware and ribbed cuffs".
   Bad: "black jacket".
4. primary_query: catalog search for the whole item.
5. distinctive_query: the unusual details (hardware, wash, cut) that would separate this SKU from similar items.
6. brand_query: null unless a logo is readable, then include the brand plus the item type.
7. Do not change the item into a different category than the one given."""

_MERGE_SYSTEM = """You merge a scene-level garment detection with a close-up chip analysis of the same item.

Prefer the chip for description, attributes, and queries — it looked at the isolated garment.
Keep brand null unless brand_cues lists a logo or tag that is actually readable. Never invent a brand.
queries: 1-3 unique catalog searches [primary, distinctive, brand_if_any]. Drop duplicates and empties.
search_query is the primary query.
description must keep distinctive visual details from the chip (hardware, wash, silhouette).
"""


def _baseten_client() -> OpenAI:
    api_key = os.getenv("BASETEN_API_KEY", "")
    if not api_key:
        raise ValueError("BASETEN_API_KEY is not set in environment")
    return OpenAI(
        api_key=api_key,
        base_url="https://inference.baseten.co/v1",
    )


def _openai_client() -> OpenAI | None:
    api_key = os.getenv("OPENAI_API_KEY", "")
    if not api_key:
        return None
    return OpenAI(api_key=api_key)


def enforce_brand(garment: dict[str, Any]) -> dict[str, Any]:
    """Brand stays null unless a cue actually exists."""
    out = dict(garment)
    cues = [
        str(cue).strip()
        for cue in (out.get("brand_cues") or [])
        if str(cue).strip()
    ]
    out["brand_cues"] = cues
    if not cues:
        out["brand"] = None
    elif not out.get("brand"):
        out["brand"] = None
    return out


def fallback_merge(garment: dict[str, Any], chip: dict[str, Any]) -> dict[str, Any]:
    """Deterministic merge when OpenAI is down. Chip overwrites scene copy."""
    merged = dict(garment)
    if chip.get("description"):
        merged["description"] = chip["description"]
    if isinstance(chip.get("attributes"), dict) and chip["attributes"].get("color"):
        merged["attributes"] = chip["attributes"]
    if chip.get("accessibility_line"):
        merged["accessibility_line"] = chip["accessibility_line"]
    try:
        chip_conf = float(chip.get("confidence") or 0)
        scene_conf = float(merged.get("confidence") or 0)
        merged["confidence"] = max(scene_conf, chip_conf)
    except (TypeError, ValueError):
        pass

    merged["brand"] = chip.get("brand")
    merged["brand_cues"] = chip.get("brand_cues") or []
    queries = unique_queries(
        chip.get("primary_query") or chip.get("search_query"),
        chip.get("distinctive_query"),
        chip.get("brand_query") if (chip.get("brand_cues") or []) else None,
        garment.get("search_query"),
    )
    if not queries:
        queries = unique_queries(garment.get("search_query") or garment.get("description"))
    merged["queries"] = queries
    merged["search_query"] = queries[0] if queries else canonicalize_query(
        garment.get("search_query") or garment.get("description") or ""
    )
    return enforce_brand(merged)


def analyze_chip(
    chip_path: str,
    category: str | None = None,
    *,
    client: OpenAI | None = None,
    model: str | None = None,
) -> dict[str, Any]:
    """Send only the cropped chip to Baseten. Returns chip detail fields."""
    path = Path(chip_path)
    if not path.is_file():
        raise FileNotFoundError(f"chip not found: {path}")
    client = client or _baseten_client()
    model = model or os.getenv("BASETEN_MODEL", "zai-org/GLM-5.3-Flash")
    kind = str(category or "garment")
    user_text = (
        f"This crop is a close-up of a single {kind}. "
        "Return ChipGarment JSON with specific visual details and catalog queries."
    )
    response = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": _CHIP_SYSTEM},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": user_text},
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": encode_image_data_uri(str(path)),
                            "detail": "high",
                        },
                    },
                ],
            },
        ],
        response_format=_CHIP_SCHEMA,
        temperature=0,
        seed=0,
        max_tokens=800,
    )
    raw = response.choices[0].message.content
    detail: dict[str, Any] = json.loads(raw or "{}")
    return enforce_brand(detail)


def merge_chip_into_garment(
    garment: dict[str, Any],
    chip: dict[str, Any],
    *,
    client: OpenAI | None = None,
    model: str | None = None,
) -> dict[str, Any]:
    """OpenAI Structured Outputs merge; local fallback if the call fails."""
    local = fallback_merge(garment, chip)
    client = client if client is not None else _openai_client()
    if client is None:
        return local
    payload = {
        "scene": {
            "category": garment.get("category"),
            "description": garment.get("description"),
            "search_query": garment.get("search_query"),
            "attributes": garment.get("attributes"),
            "brand": garment.get("brand"),
            "brand_cues": garment.get("brand_cues"),
            "accessibility_line": garment.get("accessibility_line"),
        },
        "chip": chip,
    }
    try:
        completion = client.chat.completions.create(
            model=model or os.getenv("OPENAI_RANK_MODEL", "gpt-4.1-mini"),
            messages=[
                {"role": "system", "content": _MERGE_SYSTEM},
                {"role": "user", "content": json.dumps(payload)},
            ],
            response_format=_MERGE_SCHEMA,
            temperature=0,
            seed=0,
        )
        merged = json.loads(completion.choices[0].message.content or "{}")
    except Exception:
        logger.exception("see-chip — %s: OpenAI merge failed, using local merge", garment_name(garment))
        return local

    out = dict(garment)
    out["description"] = merged.get("description") or local["description"]
    if isinstance(merged.get("attributes"), dict) and merged["attributes"].get("color"):
        out["attributes"] = merged["attributes"]
    else:
        out["attributes"] = local.get("attributes")
    out["brand"] = merged.get("brand")
    out["brand_cues"] = merged.get("brand_cues") or []
    out["accessibility_line"] = (
        merged.get("accessibility_line") or local.get("accessibility_line") or out.get("description")
    )
    queries = unique_queries(
        merged.get("search_query"),
        *(merged.get("queries") or []),
        *local.get("queries", []),
    )
    out["queries"] = queries
    out["search_query"] = queries[0] if queries else local["search_query"]
    out["confidence"] = local.get("confidence", out.get("confidence"))
    return enforce_brand(out)


def _chip_path(garment: dict[str, Any]) -> Path | None:
    return managed_media_path(garment.get("chip_key") if isinstance(garment.get("chip_key"), str) else None)


def _detail_one(
    garment: dict[str, Any],
    baseten: OpenAI | None,
    openai_client: OpenAI | None,
) -> dict[str, Any]:
    scene_query = canonicalize_query(
        garment.get("search_query") or garment.get("description") or ""
    )
    path = _chip_path(garment)
    if path is None:
        out = dict(garment)
        out["search_query"] = scene_query or out.get("search_query") or ""
        out["queries"] = unique_queries(out.get("search_query"))
        return enforce_brand(out)

    name = garment_name(garment)
    try:
        chip = analyze_chip(str(path), garment.get("category"), client=baseten)
        merged = merge_chip_into_garment(garment, chip, client=openai_client)
    except Exception:
        logger.exception("see-chip — %s: Baseten chip failed, keeping scene description", name)
        out = dict(garment)
        out["search_query"] = scene_query or out.get("search_query") or ""
        out["queries"] = unique_queries(out.get("search_query"))
        return enforce_brand(out)

    chip_query = merged.get("search_query") or ""
    logger.info(
        'see-chip — %s: scene "%s" → chip "%s"',
        name,
        scene_query[:80],
        chip_query[:80],
    )
    agent_log(
        "B",
        "see_chip.py:detail",
        "chip vs scene",
        {
            "category": name,
            "id": garment.get("id"),
            "scene_query": scene_query,
            "chip_query": chip_query,
            "queries": merged.get("queries"),
            "scene_description": str(garment.get("description") or "")[:160],
            "chip_description": str(merged.get("description") or "")[:160],
            "brand": merged.get("brand"),
            "brand_cues": merged.get("brand_cues"),
        },
    )
    return merged


def detail_garments(garments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Run SeeChip + merge for every garment that has a chip. Preserve order."""
    if not garments:
        return []
    logger.info("see-chip — detailing %s garment%s", len(garments), "" if len(garments) == 1 else "s")
    has_chips = any(_chip_path(garment) is not None for garment in garments)
    baseten = _baseten_client() if has_chips else None
    openai_client = _openai_client() if has_chips else None
    workers = min(MAX_WORKERS, len(garments))
    if workers == 1:
        return [_detail_one(garments[0], baseten, openai_client)]

    results: list[dict[str, Any] | None] = [None] * len(garments)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(_detail_one, garment, baseten, openai_client): index
            for index, garment in enumerate(garments)
        }
        for future in as_completed(futures):
            results[futures[future]] = future.result()
    return [item if item is not None else dict(garments[i]) for i, item in enumerate(results)]
