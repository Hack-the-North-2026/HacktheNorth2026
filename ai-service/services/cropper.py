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

import os
from pathlib import Path

from PIL import Image


def crop_garments(
    image_path: str,
    garments: list[dict],
    output_dir: str,
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

    updated = []
    for garment in garments:
        g = dict(garment)  # shallow copy — don't mutate caller's dict

        bbox = g.get("bbox")
        if not bbox or len(bbox) != 4:
            g["chip_key"] = g.get("chip_key", "")
            updated.append(g)
            continue

        x_min_n, y_min_n, x_max_n, y_max_n = bbox

        # Clamp to [0, 1] in case of minor VLM overshoot
        x_min_n = max(0.0, min(1.0, x_min_n))
        y_min_n = max(0.0, min(1.0, y_min_n))
        x_max_n = max(0.0, min(1.0, x_max_n))
        y_max_n = max(0.0, min(1.0, y_max_n))

        # Denormalize
        x_min = int(x_min_n * img_w)
        y_min = int(y_min_n * img_h)
        x_max = int(x_max_n * img_w)
        y_max = int(y_max_n * img_h)

        chip_w = x_max - x_min
        chip_h = y_max - y_min

        if chip_w < 32 or chip_h < 32:
            # Too small — VLM bbox was unreliable; skip this chip
            g["chip_key"] = g.get("chip_key", "")
            updated.append(g)
            continue

        chip = img.crop((x_min, y_min, x_max, y_max))
        chip_filename = f"{g['id']}.jpg"
        chip_path = out_path / chip_filename
        chip.save(chip_path, "JPEG", quality=90)

        g["chip_key"] = str(chip_path)
        updated.append(g)

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
