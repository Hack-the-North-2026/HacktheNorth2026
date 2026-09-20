"""Stage V4: video chips use the shared retrieve / honesty loop."""

from __future__ import annotations

import sys
import tempfile
import unittest
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from PIL import Image

AI_SERVICE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AI_SERVICE))

from fastapi.testclient import TestClient  # noqa: E402
from main import app, _chip_b64  # noqa: E402
from services.browserbase_scraper import should_browse  # noqa: E402
from services.cropper import first_chip_path  # noqa: E402
from services.product_ranker import DEMOTED_REASON, rank_candidates  # noqa: E402
from services.retrieval import retrieve_candidates, shopify_search_jobs  # noqa: E402


VIDEO_GARMENT = {
    "id": "jacket-00-04-02-16-14",
    "category": "jacket",
    "description": "black leather jacket silver zip",
    "search_query": "black leather jacket silver zip",
    "queries": [
        "black leather jacket silver zip",
        "silver zip hardware bomber",
    ],
    "attributes": {"color": "black", "material": "leather"},
    "brand": None,
    "brand_cues": [],
    "source_frame_index": 0,
    "chip_key": "",
}


def product(url: str, title: str = "Leather Jacket", source: str = "shopify", image: str | None = None) -> dict:
    item = {"title": title, "url": url, "source": source}
    if image:
        item["image_url"] = image
    return item


def fake_rank_client(match_type: str) -> Mock:
    ranking = {
        "matches": [
            {
                "candidate_index": 0,
                "match_type": match_type,
                "confidence": 0.96,
                "reason": "titles rhyme",
            }
        ]
    }
    client = Mock()
    client.chat.completions.create.return_value = SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps(ranking)))]
    )
    return client


class VideoChipPathTests(unittest.TestCase):
    def test_first_chip_path_prefers_primary_then_alt(self):
        work = Path(tempfile.mkdtemp(prefix="fit-stealer-v4-"))
        primary = work / "jacket.jpg"
        alt = work / "jacket-alt.jpg"
        Image.new("RGB", (16, 16), (10, 20, 30)).save(primary, "JPEG")
        Image.new("RGB", (16, 16), (40, 50, 60)).save(alt, "JPEG")
        clip = work / "clip.mp4"
        clip.write_bytes(b"not-a-chip")
        self.assertEqual(
            first_chip_path({"chip_key": str(primary), "alt_chip_key": str(alt)}),
            primary.resolve(),
        )
        self.assertEqual(first_chip_path({"chip_key": "", "alt_chip_key": str(alt)}), alt.resolve())
        self.assertIsNone(first_chip_path({"chip_key": str(clip)}))

    def test_chip_b64_reads_alt_when_primary_missing(self):
        work = Path(tempfile.mkdtemp(prefix="fit-stealer-v4-"))
        alt = work / "jacket-alt.jpg"
        Image.new("RGB", (8, 8), (1, 2, 3)).save(alt, "JPEG")
        body = type("Body", (), {})()
        body.chip = None
        body.garment = {**VIDEO_GARMENT, "chip_key": "", "alt_chip_key": str(alt)}
        self.assertTrue(_chip_b64(body))


class VideoRetrieveTests(unittest.TestCase):
    def test_video_chip_schedules_shopify_like(self):
        jobs = shopify_search_jobs(VIDEO_GARMENT, "YWJj")
        self.assertEqual([job["kind"] for job in jobs], ["primary", "distinctive", "like"])
        self.assertTrue(jobs[2]["use_like"])

    @patch("services.retrieval.search_composio_shopping")
    @patch("services.retrieval.search_shopify_catalog")
    def test_video_chip_like_and_composio_only_when_thin(self, search, composio):
        def fake_search(_garment, chip=None, query=None, use_like=None, **_kwargs):
            if use_like:
                return [product("https://shop.example/like", image="https://cdn.example/l.jpg")]
            return [product("https://shop.example/text")]

        search.side_effect = fake_search
        composio.return_value = [product("https://google.example/found", source="composio")]
        with patch.dict(
            "os.environ",
            {"COMPOSIO_API_KEY": "test-key", "COMPOSIO_SHOPPING": "auto"},
            clear=False,
        ):
            result = retrieve_candidates({**VIDEO_GARMENT, "chip_key": "/tmp/fit-stealer-chips/j.jpg"}, "YWJj")
        like_calls = [call for call in search.call_args_list if call.kwargs.get("use_like")]
        self.assertEqual(len(like_calls), 1)
        self.assertEqual(like_calls[0].args[1], "YWJj")
        composio.assert_called()
        self.assertTrue(any(item["source"] == "composio" for item in result))

    @patch("services.retrieval.search_composio_shopping")
    @patch("services.retrieval.search_shopify_catalog")
    def test_rich_video_catalog_skips_composio(self, search, composio):
        search.side_effect = [
            [product(f"https://shop.example/{i}") for i in range(4)],
            [product("https://shop.example/4")],
            [product("https://shop.example/5")],
        ]
        with patch.dict("os.environ", {"COMPOSIO_API_KEY": "test-key", "COMPOSIO_SHOPPING": "auto"}, clear=False):
            retrieve_candidates(VIDEO_GARMENT, "YWJj")
        composio.assert_not_called()

    @patch("main.retrieve_candidates")
    def test_retrieve_endpoint_forwards_video_chip(self, retrieve):
        retrieve.return_value = [product("https://shop.example/j", image="https://cdn.example/j.jpg")]
        response = TestClient(app).post(
            "/tools/retrieve",
            json={
                "garment": VIDEO_GARMENT,
                "chip": {"content_type": "image/jpeg", "data": "YWJj"},
            },
        )
        self.assertEqual(response.status_code, 200)
        retrieve.assert_called_once()
        self.assertEqual(retrieve.call_args.args[1], "YWJj")


class VideoHonestyTests(unittest.TestCase):
    def test_title_rhyme_is_not_exact_without_visual_same_item(self):
        candidate = product("https://shop.example/j", title="Black Leather Jacket")
        result = rank_candidates(
            VIDEO_GARMENT,
            [candidate],
            client=fake_rank_client("exact"),
            visual_scores=[{"candidate_index": 0, "label": "similar", "score": 0.88, "reason": "same words"}],
        )
        self.assertEqual(result[0]["match_type"], "similar")
        self.assertEqual(result[0]["reason"], DEMOTED_REASON)

    def test_video_chip_can_be_exact_when_visual_confirms(self):
        candidate = product("https://shop.example/j", title="Black Leather Jacket")
        result = rank_candidates(
            VIDEO_GARMENT,
            [candidate],
            client=fake_rank_client("exact"),
            visual_scores=[{"candidate_index": 0, "label": "same_item", "score": 0.91, "reason": "same zip as chip"}],
        )
        self.assertEqual(result[0]["match_type"], "exact")
        self.assertEqual(result[0]["visual_label"], "same_item")
        self.assertGreaterEqual(result[0]["visual_score"], 0.82)

    def test_browserbase_only_when_video_visual_is_weak(self):
        hits = [product("https://shop.example/j", image="https://cdn.example/j.jpg")]
        with patch.dict(
            "os.environ",
            {"BROWSERBASE_API_KEY": "test-key", "BROWSERBASE": "auto"},
            clear=False,
        ):
            self.assertFalse(should_browse([{"score": 0.91, "label": "same_item"}], hits))
            self.assertFalse(should_browse([{"score": 0.7, "label": "similar"}], hits))
            self.assertTrue(should_browse([{"score": 0.4, "label": "similar"}], hits))
            self.assertTrue(should_browse([], hits))


if __name__ == "__main__":
    unittest.main()
