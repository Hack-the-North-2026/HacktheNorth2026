"""Visual Judge — Baseten compares a garment chip to product listing photos.

Scores are 0–1 same-item confidence. OpenAI may claim exact only when the
score is high; this module never labels exact itself.
"""

from __future__ import annotations

import base64
import json
import logging
import os
from concurrent.futures import ThreadPoolExecutor, as_completed
from io import BytesIO
from pathlib import Path
from typing import Any

import requests
from openai import OpenAI
from PIL import Image

from logging_config import agent_log, garment_name

logger = logging.getLogger("fit_stealer.judge")

EXACT_VISUAL_THRESHOLD = 0.82
MAX_PRODUCT_IMAGES = 8
FETCH_TIMEOUT = 3.5
MAX_BYTES = 8_000_000
JUDGE_MAX_EDGE = 768
FETCH_WORKERS = 8

_JUDGE_SCHEMA = {
    "type": "json_schema",
    "json_schema": {
        "name": "VisualScores",
        "strict": True,
        "schema": {
            "type": "object",
            "properties": {
                "scores": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "candidate_index": {"type": "integer"},
                            "label": {
                                "type": "string",
                                "enum": ["same_item", "similar", "different"],
                            },
                            "score": {"type": "number"},
                            "reason": {"type": "string"},
                        },
                        "required": [
                            "candidate_index",
                            "label",
                            "score",
                            "reason",
                        ],
                        "additionalProperties": False,
                    },
                }
            },
            "required": ["scores"],
            "additionalProperties": False,
        },
    },
}

_SYSTEM = """You compare one cropped garment photo to product listing photos.

The FIRST image is the garment chip from a street / fit-check photo.
Each following image is a product photo. The user message lists candidate_index for each.

Judge PIXELS only. Ignore titles, stores, and prices.
- same_item: the same garment / SKU (color, silhouette, hardware, material, pattern match unusually closely).
- similar: same category and vibe, but not the same piece.
- different: wrong item or weak evidence.
score is 0–1 probability it is the same item.
same_item is typically >= 0.82, similar 0.40–0.81, different below 0.40.
Return one score object per product image.
"""


def encode_bytes_data_uri(data: bytes, mime: str = "image/jpeg") -> str:
    return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"


def prepare_jpeg_bytes(data: bytes, max_edge: int = JUDGE_MAX_EDGE) -> bytes | None:
    """Decode any raster image, downscale, return JPEG bytes. None if unusable."""
    if not data or len(data) < 32 or len(data) > MAX_BYTES:
        return None
    try:
        image = Image.open(BytesIO(data)).convert("RGB")
    except Exception:
        return None
    width, height = image.size
    if width < 16 or height < 16:
        return None
    longest = max(width, height)
    if longest > max_edge:
        scale = max_edge / longest
        image = image.resize(
            (max(1, int(width * scale)), max(1, int(height * scale))),
            Image.Resampling.LANCZOS,
        )
    out = BytesIO()
    image.save(out, "JPEG", quality=80)
    return out.getvalue()


def fetch_product_image(url: str, timeout: float = FETCH_TIMEOUT) -> bytes | None:
    """Download one product image. Skip broken, huge, or non-image bodies."""
    if not isinstance(url, str) or not url.startswith(("https://", "http://")):
        return None
    try:
        response = requests.get(
            url,
            timeout=timeout,
            headers={
                "Accept": "image/jpeg,image/png,image/webp,image/*;q=0.8",
                "User-Agent": "FitStealer/1.0 (visual-judge)",
            },
        )
        response.raise_for_status()
        content_type = (response.headers.get("Content-Type") or "").lower()
        if content_type.startswith("text/") or "json" in content_type:
            return None
        return prepare_jpeg_bytes(response.content)
    except (requests.RequestException, ValueError, OSError):
        return None


def fetch_candidate_images(
    candidates: list[dict[str, Any]],
    *,
    limit: int = MAX_PRODUCT_IMAGES,
) -> list[tuple[int, bytes]]:
    """Return (original_index, jpeg_bytes) for candidates with a reachable image."""
    indexed = [
        (index, str(item.get("image_url") or ""))
        for index, item in enumerate(candidates)
        if item.get("image_url")
    ][: max(1, limit)]
    if not indexed:
        return []
    prepared: list[tuple[int, bytes] | None] = [None] * len(indexed)
    workers = min(FETCH_WORKERS, len(indexed))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(fetch_product_image, url): position
            for position, (_index, url) in enumerate(indexed)
        }
        for future in as_completed(futures):
            position = futures[future]
            jpeg = future.result()
            if jpeg:
                prepared[position] = (indexed[position][0], jpeg)
    return [item for item in prepared if item is not None]


def _baseten_client() -> OpenAI:
    api_key = os.getenv("BASETEN_API_KEY", "")
    if not api_key:
        raise ValueError("BASETEN_API_KEY is not set in environment")
    return OpenAI(
        api_key=api_key,
        base_url="https://inference.baseten.co/v1",
    )


def chip_jpeg_bytes(chip: str | Path | bytes | None, garment: dict[str, Any] | None = None) -> bytes | None:
    """Load chip JPEG from garment.chip_key, a path, raw bytes, or base64."""
    key = (garment or {}).get("chip_key")
    if isinstance(key, str) and len(key) < 1024:
        path = Path(key)
        if path.is_file():
            return prepare_jpeg_bytes(path.read_bytes())
    if isinstance(chip, (bytes, bytearray)):
        return prepare_jpeg_bytes(bytes(chip))
    if isinstance(chip, Path) and chip.is_file():
        return prepare_jpeg_bytes(chip.read_bytes())
    if isinstance(chip, str) and chip:
        possible = Path(chip)
        if len(chip) < 1024 and possible.is_file():
            return prepare_jpeg_bytes(possible.read_bytes())
        try:
            return prepare_jpeg_bytes(base64.b64decode(chip, validate=False))
        except Exception:
            return None
    return None


def judge_candidates(
    chip: str | Path | bytes | None,
    candidates: list[dict[str, Any]],
    garment: dict[str, Any] | None = None,
    *,
    client: OpenAI | None = None,
    model: str | None = None,
) -> list[dict[str, Any]]:
    """Score up to 8 product photos against the chip. Empty if vision cannot run."""
    name = garment_name(garment)
    if not candidates:
        return []
    chip_bytes = chip_jpeg_bytes(chip, garment)
    if not chip_bytes:
        logger.info("judge — %s: skipped, no garment chip", name)
        return []
    photos = fetch_candidate_images(candidates)
    if not photos:
        logger.info("judge — %s: skipped, no product images fetched", name)
        return []

    client = client or _baseten_client()
    model = model or os.getenv("BASETEN_MODEL", "zai-org/GLM-5.3-Flash")
    lines = [
        "Image 1 is the garment chip.",
        "Score each product image using its candidate_index:",
    ]
    image_blocks: list[dict[str, Any]] = [
        {
            "type": "image_url",
            "image_url": {"url": encode_bytes_data_uri(chip_bytes), "detail": "high"},
        }
    ]
    for original_index, jpeg in photos:
        lines.append(f"- candidate_index {original_index}")
        image_blocks.append(
            {
                "type": "image_url",
                "image_url": {"url": encode_bytes_data_uri(jpeg), "detail": "high"},
            }
        )

    logger.info("judge — %s: comparing chip to %s product photos", name, len(photos))
    response = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": _SYSTEM},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "\n".join(lines)},
                    *image_blocks,
                ],
            },
        ],
        response_format=_JUDGE_SCHEMA,
        temperature=0,
        max_tokens=1200,
    )
    raw = response.choices[0].message.content
    payload = json.loads(raw or '{"scores": []}')
    allowed = {index for index, _jpeg in photos}
    scores: list[dict[str, Any]] = []
    seen: set[int] = set()
    for item in payload.get("scores") or []:
        index = item.get("candidate_index")
        if not isinstance(index, int) or index not in allowed or index in seen:
            continue
        try:
            score = max(0.0, min(1.0, float(item.get("score", 0))))
        except (TypeError, ValueError):
            continue
        label = item.get("label")
        if label not in {"same_item", "similar", "different"}:
            continue
        scores.append(
            {
                "candidate_index": index,
                "label": label,
                "score": score,
                "reason": str(item.get("reason") or "").strip(),
            }
        )
        seen.add(index)

    best = max((row["score"] for row in scores), default=None)
    logger.info(
        "judge — %s: scored %s photos, best %s",
        name,
        len(scores),
        f"{best:.2f}" if isinstance(best, float) else "none",
    )
    agent_log(
        "C",
        "visual_judge.py:judge",
        "visual scores",
        {
            "category": name,
            "photos": len(photos),
            "scored": len(scores),
            "best": best,
            "scores": [
                {
                    "candidate_index": row["candidate_index"],
                    "label": row["label"],
                    "score": row["score"],
                    "reason": row["reason"][:120],
                }
                for row in scores
            ],
        },
    )
    return scores
