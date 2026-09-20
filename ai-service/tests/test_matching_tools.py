from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

AI_SERVICE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AI_SERVICE))

from fastapi.testclient import TestClient  # noqa: E402
from main import app  # noqa: E402


GARMENT = {
    "id": "jacket-1",
    "category": "jacket",
    "description": "gray leather jacket",
    "search_query": "gray leather jacket",
    "attributes": {"color": "gray", "material": "leather"},
    "brand": None,
    "brand_cues": [],
}

CANDIDATE = {
    "title": "Gray Leather Jacket",
    "url": "https://shop.example/jacket",
    "image_url": "https://cdn.example/jacket.jpg",
    "source": "shopify",
}


class MatchingToolEndpointTests(unittest.TestCase):
    def test_health_lists_split_matching_tools(self):
        response = TestClient(app).get("/health")
        self.assertEqual(response.status_code, 200)
        endpoints = response.json()["endpoints"]
        for path in ("/tools/retrieve", "/tools/judge", "/tools/browse", "/tools/rank"):
            self.assertIn(path, endpoints)

    @patch("main.retrieve_candidates")
    def test_retrieve_returns_candidates(self, retrieve):
        retrieve.return_value = [CANDIDATE]
        response = TestClient(app).post(
            "/tools/retrieve",
            json={"garment": GARMENT, "chip": {"content_type": "image/jpeg", "data": "YWJj"}},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["candidates"][0]["url"], CANDIDATE["url"])
        retrieve.assert_called_once()

    @patch("main.judge_candidates")
    def test_judge_returns_best_score(self, judge):
        judge.return_value = [{"candidate_index": 0, "score": 0.91, "label": "same_item", "reason": "same"}]
        response = TestClient(app).post(
            "/tools/judge",
            json={"garment": GARMENT, "candidates": [CANDIDATE]},
        )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["best"], 0.91)
        self.assertEqual(len(body["visual_scores"]), 1)

    @patch("main.browse_products")
    def test_browse_returns_listings(self, browse):
        browse.return_value = [{**CANDIDATE, "source": "browserbase"}]
        response = TestClient(app).post("/tools/browse", json={"garment": GARMENT})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["candidates"][0]["source"], "browserbase")

    @patch("main.rank_candidates")
    def test_rank_passes_visual_scores(self, rank):
        rank.return_value = [{**CANDIDATE, "match_type": "exact", "confidence": 0.9, "reason": "same item"}]
        scores = [{"candidate_index": 0, "score": 0.91, "label": "same_item"}]
        response = TestClient(app).post(
            "/tools/rank",
            json={"garment": GARMENT, "candidates": [CANDIDATE], "visual_scores": scores},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["matches"][0]["match_type"], "exact")
        self.assertEqual(rank.call_args.kwargs.get("visual_scores"), scores)

    def test_split_tools_reject_empty_body(self):
        client = TestClient(app)
        for path in ("/tools/retrieve", "/tools/judge", "/tools/browse", "/tools/rank"):
            response = client.post(path, json={})
            self.assertEqual(response.status_code, 422, path)


if __name__ == "__main__":
    unittest.main()
