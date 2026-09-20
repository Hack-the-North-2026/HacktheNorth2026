"""Stage V1: ingest is frames-only; See crops video frames from disk paths."""

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
from services.video_processor import persist_selected_frames  # noqa: E402

GARMENT = {
    "id": "jacket-1",
    "category": "jacket",
    "description": "black leather jacket",
    "search_query": "black leather jacket",
    "confidence": 0.9,
    "bbox": [0.2, 0.1, 0.8, 0.7],
    "source_frame_index": 0,
}


class IngestV1Tests(unittest.TestCase):
    @patch("main.analyze_frames_with_vlm")
    @patch("main.cleanup_work_dir")
    @patch("main.persist_selected_frames")
    @patch("main.ingest_video_frames")
    def test_ingest_does_not_run_see(self, ingest, persist, cleanup, see):
        persist.return_value = [{
            "path": "/tmp/fit-stealer-chips/f.jpg",
            "index": 0,
            "timestamp": 0.5,
            "sharpness": 90,
        }]
        ingest.return_value = {
            "garments": [{"id": "should-not-leak"}],
            "outfit_summary": "",
            "frame_count": 5,
            "selected_frames": 1,
            "candidate_dir": "/tmp/fit-stealer-video-x",
            "frames": [{"path": "/tmp/work/c.jpg", "index": 0, "timestamp": 0.5, "sharpness": 90}],
            "image_paths": ["/tmp/work/c.jpg"],
            "keyframes": [],
        }
        response = TestClient(app).post(
            "/tools/ingest",
            files={"video": ("clip.mp4", b"fake-mp4-bytes", "video/mp4")},
        )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["garments"], [])
        self.assertEqual(body["frame_count"], 5)
        self.assertEqual(body["selected_frames"], 1)
        self.assertEqual(body["image_paths"], ["/tmp/fit-stealer-chips/f.jpg"])
        see.assert_not_called()
        cleanup.assert_called_once()

    def test_persist_selected_frames_copies_into_chips_dir(self):
        work = Path(tempfile.mkdtemp(prefix="fit-stealer-video-v1-"))
        src = work / "candidate_0000.jpg"
        Image.new("RGB", (16, 16), (12, 24, 36)).save(src)
        dest = Path(tempfile.mkdtemp(prefix="fit-stealer-chips-"))
        persisted = persist_selected_frames(
            [{"path": str(src), "index": 2, "timestamp": 1.2, "sharpness": 70}],
            str(dest),
            "jobid",
        )
        self.assertEqual(len(persisted), 1)
        copied = Path(persisted[0]["path"])
        self.assertTrue(copied.exists())
        self.assertIn("fit-stealer-chips", copied.as_posix())
        self.assertEqual(copied.name, "jobid_frame_0002.jpg")
        self.assertEqual(persisted[0]["index"], 2)

    @patch("main.detail_garments")
    @patch("main.crop_garments")
    @patch("main.analyze_frames_with_vlm")
    def test_see_json_crops_video_frames(self, analyze, crop, detail):
        dest = Path(tempfile.gettempdir()) / "fit-stealer-chips"
        dest.mkdir(parents=True, exist_ok=True)
        frame = dest / "v1_see_frame_0000.jpg"
        Image.new("RGB", (24, 24), (40, 50, 60)).save(frame)
        analyze.return_value = {"garments": [dict(GARMENT)], "outfit_summary": "leather"}
        crop.return_value = [{**GARMENT, "chip_key": str(dest / "jacket.jpg")}]

        response = TestClient(app).post(
            "/tools/see",
            json={
                "image_paths": [str(frame)],
                "frame_metadata": [{"index": 0, "timestamp": 0.2, "sharpness": 80}],
            },
        )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["garments"][0]["chip_key"], str(dest / "jacket.jpg"))
        analyze.assert_called_once()
        crop.assert_called_once()
        detail.assert_not_called()


if __name__ == "__main__":
    unittest.main()
