"""Stage V3: crop the video chip from the right pixels."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from PIL import Image, ImageDraw, ImageFilter

AI_SERVICE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AI_SERVICE))

from services.baseten_vlm import analyze_frames_with_vlm, sanitize_alt_frames  # noqa: E402
from services.cropper import crop_video_garments  # noqa: E402


def _save_solid(path: Path, color, size=(96, 96)):
    Image.new("RGB", size, color).save(path, "JPEG")


def _save_stripes(path: Path, size=(96, 96)):
    img = Image.new("RGB", size, (80, 80, 80))
    draw = ImageDraw.Draw(img)
    for y in range(0, size[1], 4):
        draw.rectangle([(0, y), (size[0], y + 2)], fill=(255, 255, 255))
        draw.rectangle([(0, y + 2), (size[0], y + 4)], fill=(0, 0, 0))
    img.save(path, "JPEG")


def _garment(**overrides):
    item = {
        "id": "jacket-01-05-05-15-15",
        "category": "jacket",
        "bbox": [0.25, 0.25, 0.75, 0.75],
        "source_frame_index": 1,
        "alt_frames": [],
        "chip_key": "",
    }
    item.update(overrides)
    return item


class VideoCropV3Tests(unittest.TestCase):
    def test_crops_from_source_frame_index_not_the_first_frame(self):
        work = Path(tempfile.mkdtemp(prefix="fit-stealer-v3-"))
        frame0 = work / "frame-0.jpg"
        frame1 = work / "frame-1.jpg"
        _save_solid(frame0, (220, 20, 20))
        _save_solid(frame1, (20, 20, 220))
        result = crop_video_garments(
            [_garment(source_frame_index=1)],
            [
                {"path": str(frame0), "index": 0, "sharpness": 99},
                {"path": str(frame1), "index": 1, "sharpness": 10},
            ],
            str(work),
        )
        chip = Path(result[0]["chip_key"])
        self.assertTrue(chip.is_file())
        with Image.open(chip) as cropped:
            r, g, b = cropped.getpixel((cropped.size[0] // 2, cropped.size[1] // 2))
        self.assertGreater(b, 150)
        self.assertLess(r, 80)
        self.assertFalse(result[0].get("crop_fallback"))

    def test_missing_source_frame_uses_sharpest_and_flags_fallback(self):
        work = Path(tempfile.mkdtemp(prefix="fit-stealer-v3-"))
        frame0 = work / "frame-0.jpg"
        frame1 = work / "frame-1.jpg"
        _save_solid(frame0, (220, 20, 20))
        _save_solid(frame1, (20, 20, 220))
        events = []
        result = crop_video_garments(
            [_garment(source_frame_index=9)],
            [
                {"path": str(frame0), "index": 0, "sharpness": 8},
                {"path": str(frame1), "index": 1, "sharpness": 90},
            ],
            str(work),
            on_fallback=lambda garment, reason, used: events.append((reason, used)),
        )
        self.assertTrue(result[0]["crop_fallback"])
        self.assertEqual(events[0][1], 1)
        chip = Path(result[0]["chip_key"])
        with Image.open(chip) as cropped:
            r, g, b = cropped.getpixel((cropped.size[0] // 2, cropped.size[1] // 2))
        self.assertGreater(b, 150)

    def test_full_person_box_skips_chip_but_keeps_garment(self):
        work = Path(tempfile.mkdtemp(prefix="fit-stealer-v3-"))
        frame = work / "frame-0.jpg"
        _save_solid(frame, (30, 30, 30), size=(80, 160))
        result = crop_video_garments(
            [_garment(id="jacket-00-00-00-20-20", bbox=[0.0, 0.0, 1.0, 1.0], source_frame_index=0)],
            [{"path": str(frame), "index": 0, "sharpness": 40}],
            str(work),
        )
        self.assertEqual(result[0]["chip_key"], "")
        self.assertEqual(result[0]["category"], "jacket")

    def test_alt_frame_becomes_chip_when_sharper(self):
        work = Path(tempfile.mkdtemp(prefix="fit-stealer-v3-"))
        sharp = work / "frame-0.jpg"
        flat = work / "frame-1.jpg"
        _save_stripes(sharp)
        _save_solid(flat, (90, 90, 90))
        Image.open(flat).filter(ImageFilter.GaussianBlur(6)).save(flat, "JPEG")
        result = crop_video_garments(
            [_garment(
                source_frame_index=1,
                alt_frames=[{"source_frame_index": 0, "bbox": [0.2, 0.2, 0.8, 0.8]}],
            )],
            [
                {"path": str(sharp), "index": 0, "sharpness": 80},
                {"path": str(flat), "index": 1, "sharpness": 12},
            ],
            str(work),
        )
        self.assertTrue(result[0]["chip_key"].endswith("-alt.jpg"))
        self.assertTrue(result[0]["alt_chip_key"])
        self.assertNotEqual(result[0]["chip_key"], result[0]["alt_chip_key"])
        self.assertEqual(result[0]["source_frame_index"], 0)

    def test_does_not_upscale_768_candidates(self):
        work = Path(tempfile.mkdtemp(prefix="fit-stealer-v3-"))
        frame = work / "frame-2.jpg"
        _save_solid(frame, (40, 80, 120), size=(768, 768))
        result = crop_video_garments(
            [_garment(id="jacket-02-05-05-15-15", source_frame_index=2)],
            [{"path": str(frame), "index": 2, "sharpness": 50}],
            str(work),
        )
        with Image.open(result[0]["chip_key"]) as cropped:
            self.assertLessEqual(max(cropped.size), 768)
            self.assertEqual(cropped.size, (460, 460))


class AltFrameSanitizeTests(unittest.TestCase):
    def test_drops_stills_and_duplicate_primary(self):
        garment = {
            "source_frame_index": 1,
            "alt_frames": [
                {"source_frame_index": 1, "bbox": [0.1, 0.1, 0.4, 0.4]},
                {"source_frame_index": 2, "bbox": [0.2, 0.2, 0.6, 0.6]},
                {"source_frame_index": 2, "bbox": [0.3, 0.3, 0.7, 0.7]},
                {"bbox": [0.1, 0.1, 0.2, 0.2]},
            ],
        }
        self.assertEqual(sanitize_alt_frames(garment, False), [])
        cleaned = sanitize_alt_frames(garment, True)
        self.assertEqual(cleaned, [{"source_frame_index": 2, "bbox": [0.2, 0.2, 0.6, 0.6]}])

    @patch("services.baseten_vlm.OpenAI")
    @patch.dict("os.environ", {"BASETEN_API_KEY": "test-key"}, clear=False)
    def test_video_see_keeps_sanitized_alt_frames(self, openai_cls):
        payload = {
            "garments": [{
                "id": "random",
                "category": "jacket",
                "description": "grey leather jacket",
                "search_query": "grey leather jacket",
                "attributes": {"color": "grey", "material": "leather", "pattern": None, "fit": None},
                "brand": None,
                "brand_cues": [],
                "confidence": 0.9,
                "bbox": [0.2, 0.2, 0.7, 0.8],
                "chip_key": "",
                "accessibility_line": "jacket",
                "source_frame_index": 0,
                "alt_frames": [{"source_frame_index": 1, "bbox": [0.25, 0.2, 0.7, 0.75]}],
            }],
            "outfit_summary": "leather",
        }
        openai_cls.return_value.chat.completions.create.return_value = SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps(payload)))]
        )
        with tempfile.TemporaryDirectory() as tmp:
            image_path = Path(tmp) / "frame.jpg"
            Image.new("RGB", (32, 32), (10, 10, 10)).save(image_path, "JPEG")
            result = analyze_frames_with_vlm(
                [str(image_path)],
                frame_metadata=[{"index": 0, "timestamp": 0.2, "sharpness": 70}],
            )
        self.assertEqual(
            result["garments"][0]["alt_frames"],
            [{"source_frame_index": 1, "bbox": [0.25, 0.2, 0.7, 0.75]}],
        )


if __name__ == "__main__":
    unittest.main()
