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
import logging
import os
import re
from pathlib import Path

from dotenv import load_dotenv
from openai import OpenAI

from logging_config import agent_log
from services.query_normalize import canonicalize_query

load_dotenv(Path(__file__).resolve().parent.parent.parent / ".env", override=True)
load_dotenv(override=True)

logger = logging.getLogger("fit_stealer.see")

MIN_CONFIDENCE = 0.5
BBOX_BINS = 20

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
                            "source_frame_index": {"type": ["integer", "null"]},
                        },
                        "required": [
                            "id", "category", "description", "search_query",
                            "attributes", "brand", "brand_cues", "confidence",
                            "bbox", "chip_key", "accessibility_line",
                            "source_frame_index",
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
3. id and chip_key: set both to empty strings — they are filled in after this call.
4. search_query must be highly specific and optimized for product catalog search. Example: "oversized black leather biker jacket with silver hardware" not just "jacket".
5. Drop any item with confidence < 0.5.
6. accessibility_line: one concise sentence describing the item for a visually impaired user.
7. outfit_summary: one sentence summarizing the full look.
8. Do NOT include people, faces, backgrounds, or non-clothing items.
9. source_frame_index: set to null for single-image input."""

_VIDEO_SYSTEM_PROMPT = """You are a precise fashion identification system analyzing video frames.

You are given multiple labeled frames extracted from a short video, already
pre-selected as the clearest views available. Each frame is labeled with its
index and timestamp.

Your task:
1. Identify all visible clothing items and accessories across the frames.
2. If the same garment appears in multiple frames, merge them into one entry. Use the frame with the clearest view for the bbox.

Rules you MUST follow:
1. brand MUST be null unless a logo, label, or clothing tag is CLEARLY and LEGIBLY readable. Never guess.
2. bbox is [x_min, y_min, x_max, y_max] normalized to 0.0–1.0 relative to the dimensions of the frame identified by source_frame_index.
3. chip_key: set to an empty string — it will be filled in by the cropper.
4. search_query must be highly specific and optimized for product catalog search.
5. Drop any item with confidence < 0.5.
6. accessibility_line: one concise sentence describing the item.
7. outfit_summary: one sentence summarizing the full look across the frames.
8. source_frame_index: the exact number shown in that frame's "[Frame N @ ...]" label — not its position in the list.
9. Do NOT include people, faces, backgrounds, or non-clothing items."""

# ---------------------------------------------------------------------------
# Frame-visibility selection (Stage 3 Tier 1.5)
# A cheap, low-detail pass that judges what pixel stats can't: is the person
# facing the camera, is the garment unobstructed, is it well lit. Runs on
# already sharpness/brightness-vetted candidates, so this only ever has to
# choose among frames that already cleared the technical bar.
# ---------------------------------------------------------------------------
_FRAME_SELECTION_SCHEMA = {
    "type": "json_schema",
    "json_schema": {
        "name": "FrameSelection",
        "strict": True,
        "schema": {
            "type": "object",
            "properties": {
                "selected": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "index": {"type": "integer"},
                            "reason": {"type": "string"},
                        },
                        "required": ["index", "reason"],
                        "additionalProperties": False,
                    },
                },
            },
            "required": ["selected"],
            "additionalProperties": False,
        },
    },
}

_FRAME_SELECTION_SYSTEM_PROMPT = """You judge which video frames best show a person's outfit for garment shopping.

You will see several frames, already confirmed to be sharp and correctly exposed.
Your only job is to rank them by how clearly the OUTFIT itself reads — not image quality.

Prefer frames where:
- The person faces the camera (front or back), not a sharp side angle
- Most of the outfit is in frame and unobstructed by arms, objects, or cropping
- Lighting shows garment color and texture rather than silhouette or glare
- There is no text overlay, sticker, or UI element covering clothing

Reject frames that are angled away, mid-motion, heavily cropped, or where the
outfit is mostly hidden — even if those frames are technically sharp."""


def quantize_bbox(bbox) -> tuple[int, int, int, int]:
    """Snap a normalized bbox to 0.05 bins so the same garment keeps the same id."""
    values = list(bbox or [0, 0, 0, 0])[:4]
    while len(values) < 4:
        values.append(0.0)
    bins: list[int] = []
    for value in values:
        try:
            number = float(value)
        except (TypeError, ValueError):
            number = 0.0
        number = max(0.0, min(1.0, number))
        bins.append(int(round(number * BBOX_BINS)))
    return bins[0], bins[1], bins[2], bins[3]


def stable_garment_id(category: str | None, bbox, used: set[str] | None = None) -> str:
    """Deterministic id from category + quantized bbox. No uuid4."""
    cat = re.sub(r"[^a-z0-9]+", "", str(category or "item").lower()) or "item"
    q0, q1, q2, q3 = quantize_bbox(bbox)
    base = f"{cat}-{q0:02d}-{q1:02d}-{q2:02d}-{q3:02d}"
    taken = used if used is not None else set()
    if base not in taken:
        taken.add(base)
        return base
    n = 2
    while f"{base}-{n}" in taken:
        n += 1
    ident = f"{base}-{n}"
    taken.add(ident)
    return ident


def encode_image_data_uri(image_path: str) -> str:
    """Base64-encode an image file to a data URI."""
    path = Path(image_path)
    suffix = path.suffix.lower()
    mime = "image/jpeg" if suffix in (".jpg", ".jpeg") else "image/png"
    with open(path, "rb") as f:
        data = base64.b64encode(f.read()).decode("utf-8")
    return f"data:{mime};base64,{data}"


def select_best_video_frames(
    image_paths: list[str],
    frame_metadata: list[dict],
    keep: int = 3,
) -> tuple[list[int], dict[int, str]]:
    """
    Tier 1.5: judge which already-vetted frames show the outfit most clearly.

    Sharpness/brightness (Tier 1) can't tell you someone's turned sideways or
    half out of frame — that needs the VLM. This call is deliberately cheap:
    low image detail and a short response, since its only job is picking
    indices, not describing garments. The (few) frames it picks are the only
    ones that ever go to the expensive high-detail identification call.

    Args:
        image_paths: Candidate frame paths (already sharpness/brightness-vetted).
        frame_metadata: Parallel list of {index, timestamp, sharpness} dicts.
        keep: Maximum number of frames to select.

    Returns:
        (selected_indices, reasons) — selected_indices is ordered best-first
        and capped at `keep`; reasons maps index -> short explanation, for
        logging so the choice is inspectable instead of opaque.
    """
    api_key = os.getenv("BASETEN_API_KEY", "")
    model = os.getenv("BASETEN_MODEL", "zai-org/GLM-5.3-Flash")

    if not api_key:
        raise ValueError("BASETEN_API_KEY is not set in environment")

    client = OpenAI(api_key=api_key, base_url="https://inference.baseten.co/v1")

    image_blocks: list[dict] = []
    for i, (p, meta) in enumerate(zip(image_paths, frame_metadata)):
        image_blocks.append({"type": "text", "text": f"[Frame {i} @ {meta.get('timestamp', 0):.1f}s]"})
        image_blocks.append({
            "type": "image_url",
            "image_url": {"url": encode_image_data_uri(p), "detail": "low"},
        })

    user_text = (
        f"These are {len(image_paths)} candidate frames from a short video, already "
        f"filtered for sharpness and exposure. Pick up to {keep} that show the outfit "
        "most clearly, ranked best first."
    )

    messages = [
        {"role": "system", "content": _FRAME_SELECTION_SYSTEM_PROMPT},
        {"role": "user", "content": [{"type": "text", "text": user_text}, *image_blocks]},
    ]

    response = client.chat.completions.create(
        model=model,
        messages=messages,
        response_format=_FRAME_SELECTION_SCHEMA,
        temperature=0,
        seed=0,
        max_tokens=400,
    )

    raw = response.choices[0].message.content
    result: dict = json.loads(raw)

    seen: set[int] = set()
    ordered: list[int] = []
    reasons: dict[int, str] = {}
    for item in result.get("selected", []):
        idx = item.get("index")
        if not isinstance(idx, int) or idx < 0 or idx >= len(image_paths) or idx in seen:
            continue
        seen.add(idx)
        ordered.append(idx)
        reasons[idx] = str(item.get("reason", ""))
        if len(ordered) >= keep:
            break

    logger.info(
        "see — frame selection kept %d/%d: %s",
        len(ordered), len(image_paths),
        ", ".join(f"#{i}" for i in ordered) or "none",
    )
    return ordered, reasons


def analyze_frames_with_vlm(
    image_paths: list[str],
    frame_metadata: list[dict] | None = None,
) -> dict:
    """
    Send image frames to Baseten VLM and return Garment[] with outfit_summary.

    Args:
        image_paths: List of local file paths to .jpg/.png images.
                     Stage 1: list of length 1 (the screenshot).
                     Stage 3: up to 3 frames, already selected by
                     select_best_video_frames() for outfit visibility.
        frame_metadata: Optional list of dicts with {index, timestamp, sharpness}
                        for each image. When provided, images are labeled as
                        video frames and the video-specific prompt is used.
                        Must be the same length as image_paths.

    Returns:
        {
            "garments": [{ id, category, description, search_query, attributes,
                           brand, brand_cues, confidence, bbox, chip_key,
                           accessibility_line, source_frame_index }, ...],
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

    is_video = frame_metadata is not None and len(frame_metadata) > 0

    logger.info(
        "see — calling Baseten (%s) with %s %s%s",
        model,
        len(image_paths),
        "video frame" if is_video else "image",
        "" if len(image_paths) == 1 else "s",
    )

    client = OpenAI(
        api_key=api_key,
        base_url="https://inference.baseten.co/v1",
    )

    # Build image content blocks — label each frame for video input.
    # IMPORTANT: label with the frame's original candidate index (meta["index"]),
    # not its position in this (possibly reduced/reordered) list. Downstream,
    # main.py looks up source_frame_index against the *full* candidate file
    # list to crop the right image — if we labeled by loop position here, a
    # frame dropped or reordered by the visibility-selection pass would make
    # the model's source_frame_index point at the wrong file.
    if is_video and frame_metadata:
        image_blocks = []
        for i, (p, meta) in enumerate(zip(image_paths, frame_metadata)):
            frame_idx = meta.get("index", i)
            ts = meta.get("timestamp", 0)
            sharpness = meta.get("sharpness", 0)
            label = f"[Frame {frame_idx} @ {ts:.1f}s | sharpness={sharpness:.0f}]"
            image_blocks.append(
                {"type": "text", "text": label}
            )
            image_blocks.append(
                {
                    "type": "image_url",
                    "image_url": {"url": encode_image_data_uri(p), "detail": "high"},
                }
            )
    else:
        image_blocks = [
            {
                "type": "image_url",
                "image_url": {"url": encode_image_data_uri(p), "detail": "high"},
            }
            for p in image_paths
        ]

    if is_video:
        user_text = (
            f"These are {len(image_paths)} frames extracted from a short video, "
            "already selected as the clearest views of the outfit. Identify all "
            "visible clothing items and accessories, merging duplicates seen "
            "across frames. Return the complete GarmentList JSON."
        )
        system_prompt = _VIDEO_SYSTEM_PROMPT
    else:
        frame_word = "image" if len(image_paths) == 1 else f"{len(image_paths)} frames"
        user_text = (
            f"Identify all visible clothing items and accessories in this {frame_word}. "
            "Return the complete GarmentList JSON."
        )
        system_prompt = _SYSTEM_PROMPT

    messages = [
        {"role": "system", "content": system_prompt},
        {
            "role": "user",
            "content": [{"type": "text", "text": user_text}, *image_blocks],
        },
    ]

    response = client.chat.completions.create(
        model=model,
        messages=messages,
        response_format=_GARMENT_SCHEMA,
        temperature=0,
        seed=0,
        max_tokens=4096 if is_video else 2048,
    )

    raw = response.choices[0].message.content
    result: dict = json.loads(raw)

    kept = []
    dropped = 0
    used_ids: set[str] = set()
    for garment in result.get("garments", []):
        try:
            confidence = float(garment.get("confidence") or 0)
        except (TypeError, ValueError):
            confidence = 0.0
        garment["confidence"] = confidence
        if confidence < MIN_CONFIDENCE:
            dropped += 1
            continue
        if garment.get("source_frame_index") is None and not is_video:
            garment["source_frame_index"] = None
        garment["id"] = stable_garment_id(
            garment.get("category"), garment.get("bbox"), used_ids
        )
        garment["search_query"] = canonicalize_query(
            garment.get("search_query") or garment.get("description") or ""
        )
        kept.append(garment)
    kept.sort(key=lambda item: (str(item.get("id") or ""), str(item.get("category") or "")))
    result["garments"] = kept
    result["outfit_summary"] = result.get("outfit_summary") or ""

    names = ", ".join(
        str(g.get("category") or "item") for g in kept
    ) or "none"
    if dropped:
        logger.info(
            "see — Baseten found %s clothes (%s), dropped %s low-confidence",
            len(kept),
            names,
            dropped,
        )
    else:
        logger.info("see — Baseten found %s clothes: %s", len(kept), names)

    # #region agent log
    agent_log(
        "A",
        "baseten_vlm.py:analyze",
        "vlm garments",
        {
            "dropped": dropped,
            "kept": len(kept),
            "outfit_summary": result.get("outfit_summary", ""),
            "garments": [
                {
                    "id": g.get("id"),
                    "category": g.get("category"),
                    "description": g.get("description"),
                    "search_query": g.get("search_query"),
                    "brand": g.get("brand"),
                    "brand_cues": g.get("brand_cues"),
                    "confidence": g.get("confidence"),
                    "bbox": g.get("bbox"),
                    "attributes": g.get("attributes"),
                }
                for g in kept
            ],
        },
    )
    # #endregion

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
