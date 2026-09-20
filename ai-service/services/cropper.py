"""
Cropper — PIL bounding box chip extractor (Stage 1)

Takes a source image and a list of Garment dicts with normalized bbox
coordinates, crops each garment, saves to disk as .jpg, and updates
chip_key in-place.

Architecture contract (§7.2):
  POST /tools/crop accepts { image_path, garments[] }
  Returns updated garments with chip_key set to saved file path.
"""

from __future__ import annotations

from pathlib import Path
import logging
import re

from PIL import Image, ImageFilter

from logging_config import agent_log

logger = logging.getLogger("fit_stealer.crop")

MAX_EDGE = 1280
BBOX_PAD_RATIO = 0.10
MAX_CHIP_COVERAGE = 0.85
MIN_CHIP_PX = 32
MANAGED_TEMP_MARK = "fit-stealer"


def managed_media_path(raw: str | None) -> Path | None:
    """Resolve a chip/upload path only if it lives under a Fit Stealer temp dir."""
    if not raw or not isinstance(raw, str) or len(raw) >= 1024:
        return None
    try:
        path = Path(raw).resolve()
    except OSError:
        return None
    if not path.is_file():
        return None
    if MANAGED_TEMP_MARK not in str(path).lower():
        return None
    return path


def first_chip_path(garment: dict | None) -> Path | None:
    """Prefer chip_key, then the video alt angle. Never a raw clip path."""
    garment = garment or {}
    for key in ("chip_key", "alt_chip_key"):
        raw = garment.get(key)
        managed = managed_media_path(raw if isinstance(raw, str) else None)
        if managed is None:
            continue
        if managed.suffix.lower() in {".mp4", ".mov", ".webm", ".mkv", ".m4v", ".avi"}:
            continue
        return managed
    return None


def prepare_image_for_see(src_path: str, dest_path: str, max_edge: int = MAX_EDGE) -> str:
    """Downscale so the longest edge is ~1280px and save a JPEG for See + Crop.

    Bounding boxes from the VLM are relative to this prepared image, so Crop
    must receive the same path. Dev 2 may also downscale; doing it here keeps
    coordinates correct even if the orchestrator forwards a 4K original.
    """
    img = Image.open(src_path).convert("RGB")
    width, height = img.size
    longest = max(width, height)
    if longest > max_edge:
        scale = max_edge / longest
        img = img.resize(
            (max(1, int(width * scale)), max(1, int(height * scale))),
            Image.Resampling.LANCZOS,
        )
        logger.info(
            "ingest — AI resized %sx%s so longest edge is %s",
            width,
            height,
            max_edge,
        )
    out = Path(dest_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out, "JPEG", quality=85)
    return str(out.resolve())


def pad_pixel_box(
    x_min: int,
    y_min: int,
    x_max: int,
    y_max: int,
    img_w: int,
    img_h: int,
    pad_ratio: float = BBOX_PAD_RATIO,
) -> tuple[int, int, int, int]:
    """Expand a pixel box by pad_ratio on each side, clamped to the image."""
    box_w = max(0, x_max - x_min)
    box_h = max(0, y_max - y_min)
    pad_x = int(round(box_w * pad_ratio))
    pad_y = int(round(box_h * pad_ratio))
    return (
        max(0, x_min - pad_x),
        max(0, y_min - pad_y),
        min(img_w, x_max + pad_x),
        min(img_h, y_max + pad_y),
    )


def chip_sharpness(image: Image.Image) -> float:
    """Laplacian-style variance of a chip. Higher is sharper."""
    edges = image.convert("L").filter(ImageFilter.FIND_EDGES)
    hist = edges.histogram()
    total = sum(hist) or 1
    mean = sum(index * count for index, count in enumerate(hist)) / total
    return float(sum(((index - mean) ** 2) * count for index, count in enumerate(hist)) / total)


def chip_sharpness_path(path: str) -> float:
    try:
        with Image.open(path) as image:
            return chip_sharpness(image)
    except Exception:
        return 0.0


def _frame_index(value) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _sharpest_frame(frames: list[dict]) -> dict | None:
    best = None
    best_score = float("-inf")
    for frame in frames or []:
        try:
            score = float(frame.get("sharpness") or 0)
        except (TypeError, ValueError):
            score = 0.0
        if score > best_score:
            best_score = score
            best = frame
    return best


def _managed_frame_path(frame: dict | None) -> str | None:
    if not frame:
        return None
    managed = managed_media_path(str(frame.get("path") or ""))
    return str(managed) if managed else None


def _log_video_crop_fallback(garment: dict, reason: str, used_index: int | None) -> None:
    logger.warning(
        "crop — video.crop_fallback garment=%s reason=%s requested=%s used=%s",
        garment.get("id"),
        reason,
        garment.get("source_frame_index"),
        used_index,
    )
    try:
        import sentry_sdk

        sentry_sdk.capture_message("video.crop_fallback", level="warning")
    except Exception:
        pass


def crop_video_garments(
    garments: list[dict],
    frames: list[dict],
    output_dir: str,
    on_fallback=None,
) -> list[dict]:
    """Crop each video garment from the frame named by source_frame_index.

    Missing or out-of-range source_frame_index falls back to the sharpest kept
    frame and marks crop_fallback. A second usable box on another frame is
    cropped as alt_chip_key; the sharper chip becomes chip_key for SeeChip.
    Coverage skip still leaves the garment for text search.
    """
    if not garments:
        return garments
    if not frames:
        return [dict(item) for item in garments]

    by_index: dict[int, dict] = {}
    for frame in frames or []:
        index = _frame_index(frame.get("index"))
        if index is not None:
            by_index[index] = frame

    notify = on_fallback or _log_video_crop_fallback
    updated = []
    for garment in garments:
        g = dict(garment)
        requested = _frame_index(g.get("source_frame_index"))
        frame = by_index.get(requested) if requested is not None else None
        used_fallback = frame is None
        if used_fallback:
            frame = _sharpest_frame(frames)
        frame_path = _managed_frame_path(frame)
        used_index = _frame_index(frame.get("index")) if frame else None

        if frame_path is None:
            g["chip_key"] = g.get("chip_key") or ""
            g["alt_chip_key"] = g.get("alt_chip_key") or ""
            if used_fallback:
                g["crop_fallback"] = True
                notify(g, "no_usable_frame", used_index)
            updated.append(g)
            continue

        if used_fallback:
            g["crop_fallback"] = True
            notify(g, "missing_or_oor_source_frame", used_index)

        primary = crop_garments(frame_path, [g], output_dir)[0]
        g.update(primary)

        alt_chips: list[dict] = []
        for alt in g.get("alt_frames") or []:
            alt_index = _frame_index(alt.get("source_frame_index") if isinstance(alt, dict) else None)
            alt_bbox = alt.get("bbox") if isinstance(alt, dict) else None
            if alt_index is None or alt_index == requested:
                continue
            if not alt_bbox or len(alt_bbox) != 4:
                continue
            alt_path = _managed_frame_path(by_index.get(alt_index))
            if not alt_path:
                continue
            alt_garment = dict(g)
            alt_garment["bbox"] = alt_bbox
            alt_garment["source_frame_index"] = alt_index
            alt_cropped = crop_garments(alt_path, [alt_garment], output_dir, name_suffix="-alt")[0]
            alt_key = alt_cropped.get("chip_key") or ""
            if not alt_key:
                continue
            alt_chips.append({
                "chip_key": alt_key,
                "bbox": alt_bbox,
                "source_frame_index": alt_index,
                "sharpness": chip_sharpness_path(alt_key),
            })

        primary_key = g.get("chip_key") or ""
        if alt_chips:
            best_alt = max(alt_chips, key=lambda item: item["sharpness"])
            if not primary_key or best_alt["sharpness"] > chip_sharpness_path(primary_key):
                if primary_key:
                    g["alt_chip_key"] = primary_key
                elif len(alt_chips) > 1:
                    second = sorted(alt_chips, key=lambda item: item["sharpness"], reverse=True)[1]
                    g["alt_chip_key"] = second["chip_key"]
                else:
                    g["alt_chip_key"] = ""
                g["chip_key"] = best_alt["chip_key"]
                g["bbox"] = best_alt["bbox"]
                g["source_frame_index"] = best_alt["source_frame_index"]
            else:
                g["alt_chip_key"] = best_alt["chip_key"]
        else:
            g.setdefault("alt_chip_key", "")

        updated.append(g)
    return updated


def crop_garments(
    image_path: str,
    garments: list[dict],
    output_dir: str,
    name_suffix: str = "",
) -> list[dict]:
    """
    Crop bounding-box chips from a source image for each garment.

    Args:
        image_path:  Absolute or relative path to the source .jpg/.png.
        garments:    List of Garment dicts. Each must have:
                       - "id": str
                       - "bbox": [x_min, y_min, x_max, y_max] normalized 0–1
        output_dir:  Directory to write chip files into (created if absent).

    Returns:
        The same garment list with "chip_key" updated to the saved file path.

    Notes:
        - bbox values are NORMALIZED (0.0–1.0). This function denormalizes them
          using the actual image dimensions before cropping.
        - If Dev 2 downscales the image before sending it, the bbox coordinates
          from the VLM already map to the downscaled dimensions — no extra math
          needed here, as long as we receive the same image that was analyzed.
        - Minimum chip dimension: 32×32 px. Smaller crops are skipped (chip_key
          left as-is) to avoid feeding garbage to Shopify.
    """
    out_path = Path(output_dir)
    out_path.mkdir(parents=True, exist_ok=True)

    img = Image.open(image_path).convert("RGB")
    img_w, img_h = img.size
    logger.info("crop — cutting chips from %sx%s image for %s garments", img_w, img_h, len(garments))

    updated = []
    saved = 0
    skipped = 0
    chip_stats = []
    for garment in garments:
        g = dict(garment)  # shallow copy — don't mutate caller's dict

        bbox = g.get("bbox")
        if not bbox or len(bbox) != 4:
            g["chip_key"] = g.get("chip_key", "")
            skipped += 1
            chip_stats.append(
                {
                    "id": g.get("id"),
                    "category": g.get("category"),
                    "skipped": True,
                    "reason": "missing_bbox",
                    "bbox": bbox,
                }
            )
            updated.append(g)
            continue

        x_min_n, y_min_n, x_max_n, y_max_n = (float(v) for v in bbox)
        looks_normalized = max(abs(x_min_n), abs(y_min_n), abs(x_max_n), abs(y_max_n)) <= 1.5

        if looks_normalized:
            x_min = int(max(0.0, min(1.0, x_min_n)) * img_w)
            y_min = int(max(0.0, min(1.0, y_min_n)) * img_h)
            x_max = int(max(0.0, min(1.0, x_max_n)) * img_w)
            y_max = int(max(0.0, min(1.0, y_max_n)) * img_h)
        else:
            x_min = int(max(0, min(img_w, x_min_n)))
            y_min = int(max(0, min(img_h, y_min_n)))
            x_max = int(max(0, min(img_w, x_max_n)))
            y_max = int(max(0, min(img_h, y_max_n)))

        if x_max < x_min:
            x_min, x_max = x_max, x_min
        if y_max < y_min:
            y_min, y_max = y_max, y_min

        raw_w = max(0, x_max - x_min)
        raw_h = max(0, y_max - y_min)
        coverage = (raw_w * raw_h) / max(1, img_w * img_h)
        if coverage >= MAX_CHIP_COVERAGE:
            g["chip_key"] = g.get("chip_key", "")
            skipped += 1
            chip_stats.append(
                {
                    "id": g.get("id"),
                    "category": g.get("category"),
                    "skipped": True,
                    "reason": "full_person",
                    "bbox": bbox,
                    "px": [raw_w, raw_h],
                    "coverage": round(coverage, 3),
                }
            )
            updated.append(g)
            continue

        x_min, y_min, x_max, y_max = pad_pixel_box(
            x_min, y_min, x_max, y_max, img_w, img_h
        )
        chip_w = x_max - x_min
        chip_h = y_max - y_min

        if chip_w < MIN_CHIP_PX or chip_h < MIN_CHIP_PX:
            g["chip_key"] = g.get("chip_key", "")
            skipped += 1
            chip_stats.append(
                {
                    "id": g.get("id"),
                    "category": g.get("category"),
                    "skipped": True,
                    "reason": "too_small",
                    "bbox": bbox,
                    "px": [chip_w, chip_h],
                }
            )
            updated.append(g)
            continue

        chip = img.crop((x_min, y_min, x_max, y_max))
        garment_id = str(g.get("id") or "garment")
        safe_id = re.sub(r"[^a-zA-Z0-9._-]+", "", garment_id) or "garment"
        suffix = re.sub(r"[^a-zA-Z0-9._-]+", "", name_suffix or "")
        chip_path = out_path / f"{safe_id}{suffix}.jpg"
        chip.save(chip_path, "JPEG", quality=90)

        g["chip_key"] = str(chip_path)
        saved += 1
        chip_stats.append(
            {
                "id": g.get("id"),
                "category": g.get("category"),
                "skipped": False,
                "bbox": bbox,
                "px": [chip_w, chip_h],
                "image": [img_w, img_h],
                "padded": True,
                "coverage": round(coverage, 3),
            }
        )
        updated.append(g)

    if skipped:
        logger.info("crop — saved %s chips, skipped %s (bbox missing, too small, or full-person)", saved, skipped)
    else:
        logger.info("crop — saved %s chips", saved)

    # #region agent log
    agent_log(
        "B",
        "cropper.py:crop_garments",
        "chip crop results",
        {"image": [img_w, img_h], "saved": saved, "skipped": skipped, "chips": chip_stats},
    )
    # #endregion

    return updated


# ---------------------------------------------------------------------------
# Standalone test
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import json
    import sys

    if len(sys.argv) < 3:
        print("Usage: python cropper.py <image_path> <garments_json_path>")
        sys.exit(1)

    image_p = sys.argv[1]
    garments_p = sys.argv[2]

    with open(garments_p) as f:
        garments_in = json.load(f)

    chips_dir = str(Path(image_p).parent / "chips")
    result = crop_garments(image_p, garments_in, chips_dir)

    for g in result:
        print(f"  [{g['category']}] chip_key={g['chip_key']}")
