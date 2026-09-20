"""Stage V2: freeze the dice for video — stable ids, duration, deterministic VLM."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from PIL import Image

AI_SERVICE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AI_SERVICE))

from fastapi.testclient import TestClient  # noqa: E402
from main import app  # noqa: E402
from services.baseten_vlm import (  # noqa: E402
    analyze_frames_with_vlm,
    select_best_video_frames,
    stable_garment_id,
)


VIDEO_GARMENT = {
    "id": "random-from-model",
    "category": "jacket",
    "description": "The oversized grey leather jacket",
    "search_query": "The Oversized Grey Leather Jacket with a Silver Zip",
    "attributes": {
        "color": "grey",
        "material": "leather",
        "pattern": None,
        "fit": "oversized",
    },
    "brand": None,
    "brand_cues": [],
    "confidence": 0.9,
    "bbox": [0.12, 0.20, 0.71, 0.88],
    "chip_key": "",
    "accessibility_line": "Grey leather jacket",
    "source_frame_index": 2,
}


class VideoStableIdTests(unittest.TestCase):
    def test_video_id_includes_source_frame_index(self):
        ident = stable_garment_id("jacket", [0.11, 0.20, 0.71, 0.88], source_frame_index=2)
        still = stable_garment_id("jacket", [0.11, 0.20, 0.71, 0.88])
        self.assertTrue(ident.startswith("jacket-02-"))
        self.assertNotEqual(ident, still)
        self.assertEqual(
            ident,
            stable_garment_id("jacket", [0.12, 0.21, 0.70, 0.89], source_frame_index=2),
        )

    def test_same_jacket_on_two_frames_does_not_collide(self):
        used = set()
        first = stable_garment_id("jacket", [0.2, 0.1, 0.8, 0.7], used, 0)
        second = stable_garment_id("jacket", [0.2, 0.1, 0.8, 0.7], used, 1)
        self.assertNotEqual(first, second)
        self.assertTrue(first.startswith("jacket-00-"))
        self.assertTrue(second.startswith("jacket-01-"))

    def test_still_ids_stay_category_plus_bbox(self):
        ident = stable_garment_id("pants", [0.24, 0.40, 0.55, 0.90])
        self.assertEqual(ident.count("-"), 4)
        self.assertTrue(ident.startswith("pants-"))


class VideoSeeDeterminismTests(unittest.TestCase):
    @patch("services.baseten_vlm.OpenAI")
    @patch.dict("os.environ", {"BASETEN_API_KEY": "test-key"}, clear=False)
    def test_video_see_uses_temp_zero_and_frame_id(self, openai_cls):
        payload = {"garments": [dict(VIDEO_GARMENT)], "outfit_summary": "street leather"}
        openai_cls.return_value.chat.completions.create.return_value = SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps(payload)))]
        )
        with tempfile.TemporaryDirectory() as tmp:
            image_path = Path(tmp) / "frame.jpg"
            Image.new("RGB", (64, 64), (10, 10, 10)).save(image_path, "JPEG")
            result = analyze_frames_with_vlm(
                [str(image_path)],
                frame_metadata=[{"index": 2, "timestamp": 1.2, "sharpness": 90}],
            )
        kwargs = openai_cls.return_value.chat.completions.create.call_args.kwargs
        self.assertEqual(kwargs["temperature"], 0)
        self.assertEqual(kwargs["seed"], 0)
        garment = result["garments"][0]
        expected = stable_garment_id("jacket", [0.12, 0.20, 0.71, 0.88], source_frame_index=2)
        self.assertEqual(garment["id"], expected)
        self.assertNotEqual(garment["id"], "random-from-model")
        self.assertEqual(garment["search_query"], "oversized gray leather jacket silver zip")
        self.assertEqual(garment["source_frame_index"], 2)

    @patch("services.baseten_vlm.OpenAI")
    @patch.dict("os.environ", {"BASETEN_API_KEY": "test-key"}, clear=False)
    def test_frame_selection_uses_temp_zero_and_seed_zero(self, openai_cls):
        openai_cls.return_value.chat.completions.create.return_value = SimpleNamespace(
            choices=[
                SimpleNamespace(
                    message=SimpleNamespace(
                        content=json.dumps({"selected": [{"index": 1, "reason": "front"}]})
                    )
                )
            ]
        )
        with tempfile.TemporaryDirectory() as tmp:
            paths = []
            for i in range(2):
                path = Path(tmp) / f"f{i}.jpg"
                Image.new("RGB", (16, 16), (i * 40, 10, 10)).save(path, "JPEG")
                paths.append(str(path))
            selected, reasons = select_best_video_frames(
                paths,
                [{"index": 0, "timestamp": 0.0}, {"index": 1, "timestamp": 0.5}],
                keep=1,
            )
        kwargs = openai_cls.return_value.chat.completions.create.call_args.kwargs
        self.assertEqual(kwargs["temperature"], 0)
        self.assertEqual(kwargs["seed"], 0)
        self.assertEqual(selected, [1])
        self.assertEqual(reasons[1], "front")


class IngestDurationTests(unittest.TestCase):
    @patch("main.analyze_frames_with_vlm")
    @patch("main.cleanup_work_dir")
    @patch("main.persist_selected_frames")
    @patch("main.ingest_video_frames")
    def test_ingest_returns_ffprobe_duration(self, ingest, persist, cleanup, see):
        persist.return_value = [{
            "path": "/tmp/fit-stealer-chips/f.jpg",
            "index": 0,
            "timestamp": 0.5,
            "sharpness": 90,
        }]
        ingest.return_value = {
            "garments": [],
            "outfit_summary": "",
            "frame_count": 5,
            "selected_frames": 1,
            "candidate_dir": "/tmp/fit-stealer-video-x",
            "frames": [{"path": "/tmp/work/c.jpg", "index": 0, "timestamp": 0.5, "sharpness": 90}],
            "image_paths": ["/tmp/work/c.jpg"],
            "keyframes": [],
            "duration": 8.4,
        }
        response = TestClient(app).post(
            "/tools/ingest",
            files={"video": ("clip.mp4", b"fake-mp4-bytes", "video/mp4")},
        )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["duration"], 8.4)
        see.assert_not_called()
        cleanup.assert_called_once()


if __name__ == "__main__":
    unittest.main()
