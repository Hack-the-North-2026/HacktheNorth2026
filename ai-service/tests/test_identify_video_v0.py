"""Stage V0: identify-video crops only. Express owns SeeChip."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

AI_SERVICE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AI_SERVICE))

from fastapi.testclient import TestClient  # noqa: E402
from main import app  # noqa: E402

GARMENT = {
    "id": "jacket-1",
    "category": "jacket",
    "description": "black leather jacket",
    "search_query": "black leather jacket",
    "confidence": 0.9,
    "bbox": [0.2, 0.1, 0.8, 0.7],
    "source_frame_index": 0,
}


class IdentifyVideoV0Tests(unittest.TestCase):
    def test_health_reports_ffmpeg(self):
        response = TestClient(app).get("/health")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertIn(body.get("ffmpeg"), ("ok", "missing"))
        self.assertIn("/api/identify-video", body["endpoints"])

    @patch("main.detail_garments")
    @patch("main.cleanup_work_dir")
    @patch("main.crop_video_garments")
    @patch("main.select_and_identify_from_video")
    def test_identify_video_crops_and_skips_seechip(self, ingest, crop, cleanup, detail):
        work = Path(tempfile.mkdtemp(prefix="fit-stealer-video-v0-"))
        candidates = work / "candidates"
        candidates.mkdir()
        frame = candidates / "candidate_0000.jpg"
        Image.new("RGB", (32, 32), (20, 40, 60)).save(frame)

        ingest.return_value = {
            "garments": [dict(GARMENT)],
            "outfit_summary": "leather jacket",
            "frame_count": 1,
            "selected_frames": 1,
            "candidate_dir": str(work),
            "keyframes": ["data:image/jpeg;base64,xx"],
            "frames": [{
                "path": str(frame),
                "timestamp": 0.0,
                "sharpness": 80,
                "index": 0,
            }],
            "image_paths": [str(frame)],
        }
        crop.return_value = [{**GARMENT, "chip_key": "/tmp/fit-stealer-chips/jacket.jpg"}]

        response = TestClient(app).post(
            "/api/identify-video?detail=0",
            files={"video": ("clip.mp4", b"fake-mp4-bytes", "video/mp4")},
        )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["garments"][0]["chip_key"], "/tmp/fit-stealer-chips/jacket.jpg")
        self.assertEqual(body["garments"][0]["source_frame_index"], 0)
        crop.assert_called_once()
        detail.assert_not_called()
        cleanup.assert_called_once()

    @patch("main.detail_garments")
    @patch("main.cleanup_work_dir")
    @patch("main.crop_video_garments")
    @patch("main.select_and_identify_from_video")
    def test_identify_video_ignores_detail_flag(self, ingest, crop, cleanup, detail):
        ingest.return_value = {
            "garments": [dict(GARMENT)],
            "outfit_summary": "leather jacket",
            "frame_count": 1,
            "selected_frames": 1,
            "candidate_dir": "",
            "keyframes": [],
        }
        response = TestClient(app).post(
            "/api/identify-video?detail=1",
            files={"video": ("clip.mp4", b"fake-mp4-bytes", "video/mp4")},
        )
        self.assertEqual(response.status_code, 200)
        detail.assert_not_called()
        crop.assert_called_once()

    @patch("main.cleanup_work_dir")
    @patch("main.crop_video_garments")
    @patch("main.select_and_identify_from_video")
    def test_identify_video_empty_ingest_sets_reason(self, ingest, crop, cleanup):
        ingest.return_value = {
            "garments": [],
            "outfit_summary": "Couldn't find a clear enough view of the outfit in this clip.",
            "frame_count": 0,
            "selected_frames": 0,
            "candidate_dir": "",
            "keyframes": [],
            "frames": [],
            "image_paths": [],
        }
        crop.return_value = []
        response = TestClient(app).post(
            "/api/identify-video?detail=0",
            files={"video": ("clip.mp4", b"fake-mp4-bytes", "video/mp4")},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["empty_reason"], "ingest")


if __name__ == "__main__":
    unittest.main()
