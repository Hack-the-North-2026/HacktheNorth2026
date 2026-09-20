"""
Baseten VLM Service — See step (Stage 1)

Sends image frames to Baseten's OpenAI-compatible vision API and enforces the
Garment[] schema via OpenAI Structured Outputs (strict: true).

Architecture contract: analyze_frames_with_vlm(image_paths) -> dict
  Returns: { "garments": [Garment, ...], "outfit_summary": str }

Brand rule: brand MUST be null unless a logo or clothing tag is clearly legible
in the image. Never guess or invent a brand name.
"""

from __future__ import annotations

import base64
import json
import os
import uuid
from pathlib import Path

from dotenv import load_dotenv
from openai import OpenAI

load_dotenv(Path(__file__).resolve().parent.parent.parent / ".env", override=True)
load_dotenv(override=True)

MIN_CONFIDENCE = 0.5

# ---------------------------------------------------------------------------
# Garment JSON Schema (strict: true)
# Architecture doc §6 — Canonical contracts
# ---------------------------------------------------------------------------
_GARMENT_SCHEMA = {
    "type": "json_schema",
    "json_schema": {
        "name": "GarmentList",
        "strict": True,
        "schema": {
            "type": "object",
            "properties": {
                "garments": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": {"type": "string"},
                            "category": {
                                "type": "string",
                                "enum": [
                                    "jacket", "shirt", "pants", "shorts",
                                    "skirt", "dress", "shoes", "bag",
                                    "hat", "accessory",
                                ],
                            },
                            "description": {"type": "string"},
                            "search_query": {"type": "string"},
                            "attributes": {
                                "type": "object",
                                "properties": {
                                    "color":    {"type": "string"},
                                    "material": {"type": ["string", "null"]},
                                    "pattern":  {"type": ["string", "null"]},
                                    "fit":      {"type": ["string", "null"]},
                                },
                                "required": ["color", "material", "pattern", "fit"],
                                "additionalProperties": False,
                            },
                            "brand":            {"type": ["string", "null"]},
                            "brand_cues":       {
                                "type": "array",
                                "items": {"type": "string"},
                            },
                            "confidence":       {"type": "number"},
                            "bbox": {
                                "type": "array",
                                "items": {"type": "number"},
                                "minItems": 4,
                                "maxItems": 4,
                            },
                            "chip_key":         {"type": "string"},
                            "accessibility_line": {"type": "string"},
                        },
                        "required": [
                            "id", "category", "description", "search_query",
                            "attributes", "brand", "brand_cues", "confidence",
                            "bbox", "chip_key", "accessibility_line",
                        ],
                        "additionalProperties": False,
                    },
                },
                "outfit_summary": {"type": "string"},
            },
            "required": ["garments", "outfit_summary"],
            "additionalProperties": False,
        },
    },
}

_SYSTEM_PROMPT = """You are a precise fashion identification system.

Your task: analyze the image and return ONLY the clothing items and accessories that are clearly visible.

Rules you MUST follow:
1. brand MUST be null unless a logo, label, or clothing tag is CLEARLY and LEGIBLY readable in the image. Never guess. Never infer from the style.
2. bbox is [x_min, y_min, x_max, y_max] normalized to 0.0–1.0 relative to image dimensions.
3. chip_key: set to an empty string — it will be filled in by the cropper.
4. search_query must be highly specific and optimized for product catalog search. Example: "oversized black leather biker jacket with silver hardware" not just "jacket".
5. Drop any item with confidence < 0.5.
6. accessibility_line: one concise sentence describing the item for a visually impaired user.
7. outfit_summary: one sentence summarizing the full look.
8. Do NOT include people, faces, backgrounds, or non-clothing items."""


def _encode_image(image_path: str) -> str:
    """Base64-encode an image file to a data URI."""
    path = Path(image_path)
    suffix = path.suffix.lower()
    mime = "image/jpeg" if suffix in (".jpg", ".jpeg") else "image/png"
    with open(path, "rb") as f:
        data = base64.b64encode(f.read()).decode("utf-8")
    return f"data:{mime};base64,{data}"


def analyze_frames_with_vlm(image_paths: list[str]) -> dict:
    """
    Send image frames to Baseten VLM and return Garment[] with outfit_summary.

    Args:
        image_paths: List of local file paths to .jpg/.png images.
                     Stage 1: list of length 1 (the screenshot).
                     Stage 3: 2–5 keyframes.

    Returns:
        {
            "garments": [{ id, category, description, search_query, attributes,
                           brand, brand_cues, confidence, bbox, chip_key,
                           accessibility_line }, ...],
            "outfit_summary": str
        }
    """
    load_dotenv(Path(__file__).resolve().parent.parent.parent / ".env", override=True)
    api_key = os.getenv("BASETEN_API_KEY", "").strip()
    model = os.getenv("BASETEN_MODEL", "zai-org/GLM-5.3-Flash").strip()

    if not api_key:
        raise ValueError("BASETEN_API_KEY is not set in environment")
    if not image_paths:
        raise ValueError("image_paths must not be empty")

    client = OpenAI(
        api_key=api_key,
        base_url="https://inference.baseten.co/v1",
    )

    # Build image content blocks (one per frame)
    image_blocks = [
        {
            "type": "image_url",
            "image_url": {"url": _encode_image(p), "detail": "high"},
        }
        for p in image_paths
    ]

    frame_word = "image" if len(image_paths) == 1 else f"{len(image_paths)} frames"
    user_text = (
        f"Identify all visible clothing items and accessories in this {frame_word}. "
        "Return the complete GarmentList JSON."
    )

    messages = [
        {"role": "system", "content": _SYSTEM_PROMPT},
        {
            "role": "user",
            "content": [{"type": "text", "text": user_text}, *image_blocks],
        },
    ]

    response = client.chat.completions.create(
        model=model,
        messages=messages,
        response_format=_GARMENT_SCHEMA,
        temperature=0.1,  # Low temp for consistent structured outputs
        max_tokens=2048,
    )

    raw = response.choices[0].message.content
    result: dict = json.loads(raw)

    kept = []
    for garment in result.get("garments", []):
        if not garment.get("id"):
            garment["id"] = str(uuid.uuid4())
        try:
            confidence = float(garment.get("confidence") or 0)
        except (TypeError, ValueError):
            confidence = 0.0
        garment["confidence"] = confidence
        if confidence < MIN_CONFIDENCE:
            continue
        kept.append(garment)
    result["garments"] = kept
    result["outfit_summary"] = result.get("outfit_summary") or ""

    return result


# ---------------------------------------------------------------------------
# Phase 1 standalone test runner
# ---------------------------------------------------------------------------
def _find_image_file(target: str) -> Path | None:
    p = Path(target)
    if p.exists():
        return p.resolve()
    
    # Check relative to ai-service directory
    ai_service_dir = Path(__file__).resolve().parent.parent
    if (ai_service_dir / p).exists():
        return (ai_service_dir / p).resolve()
    if (ai_service_dir / p.name).exists():
        return (ai_service_dir / p.name).resolve()
        
    # Check relative to project root
    project_root = ai_service_dir.parent
    if (project_root / p).exists():
        return (project_root / p).resolve()
    if (project_root / p.name).exists():
        return (project_root / p.name).resolve()

    return None


if __name__ == "__main__":
    import sys

    raw_test_image = os.getenv("TEST_IMAGE_PATH", "ai-service/test_outfit.png")

    # Allow overriding from CLI: python baseten_vlm.py path/to/image.jpg
    if len(sys.argv) > 1:
        raw_test_image = sys.argv[1]

    found_path = _find_image_file(raw_test_image)
    if not found_path:
        print(f"[ERROR] Test image not found: {raw_test_image}")
        print("   Drop a clothing screenshot at that path, or pass one as an argument.")
        sys.exit(1)

    test_image = str(found_path)
    print(f"[INFO] Analyzing: {test_image}")
    print(f"       Model: {os.getenv('BASETEN_MODEL', 'zai-org/GLM-5.3-Flash')}")

    result = analyze_frames_with_vlm([test_image])
    garments = result.get("garments", [])

    print(f"\n[OK] Garments found: {len(garments)}")
    for i, g in enumerate(garments):
        print(f"  [{i}] {g['category']} -- \"{g['search_query']}\" (conf: {g['confidence']:.2f})")
        if g["brand"]:
            print(f"       brand: {g['brand']} | cues: {g['brand_cues']}")

    print(f"\n[SUMMARY] Outfit summary: {result.get('outfit_summary', '')}")

    # Run cropper too
    from cropper import crop_garments  # noqa: E402

    chips_dir = Path(test_image).parent / "chips"
    updated = crop_garments(test_image, garments, str(chips_dir))
    print(f"\n[OK] Chips saved:")
    for g in updated:
        print(f"  --> {g['chip_key']}")

