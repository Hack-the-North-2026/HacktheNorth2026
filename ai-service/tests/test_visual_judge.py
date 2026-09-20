from __future__ import annotations

import json
import sys
import unittest
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from PIL import Image

AI_SERVICE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AI_SERVICE))

from services.product_ranker import (  # noqa: E402
    DEMOTED_REASON,
    category_agrees,
    fallback_rank_candidates,
    rank_candidates,
)
from services.source_and_rank import source_and_rank  # noqa: E402
from services.visual_judge import (  # noqa: E402
    EXACT_VISUAL_THRESHOLD,
    chip_jpeg_bytes,
    fetch_candidate_images,
    fetch_product_image,
    is_public_http_url,
    judge_candidates,
    prepare_jpeg_bytes,
)


GARMENT = {
    "id": "jacket-05-06-15-11",
    "category": "jacket",
    "description": "black leather bomber with silver zip hardware",
    "search_query": "black leather bomber jacket ribbed collar cuffs",
    "attributes": {"color": "black", "material": "leather", "fit": "oversized"},
    "brand": None,
    "brand_cues": [],
}

JACKET = {
    "title": "Men's Bomber Leather Jacket Ribbed Collar",
    "url": "https://shop.example/bomber",
    "image_url": "https://cdn.example/bomber.jpg",
    "source": "shopify",
}


def jpeg_bytes(color=(20, 30, 40)) -> bytes:
    buf = BytesIO()
    Image.new("RGB", (48, 48), color).save(buf, "JPEG", quality=80)
    return buf.getvalue()


def fake_rank_client(match_type: str, index: int = 0) -> Mock:
    ranking = {
        "matches": [
            {
                "candidate_index": index,
                "match_type": match_type,
                "confidence": 0.96,
                "reason": "Same black leather bomber.",
            }
        ]
    }
    client = Mock()
    client.chat.completions.create.return_value = SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps(ranking)))]
    )
    return client


class ImagePrepTests(unittest.TestCase):
    def test_prepare_jpeg_accepts_png_bytes(self):
        buf = BytesIO()
        Image.new("RGB", (80, 40), (9, 9, 9)).save(buf, "PNG")
        jpeg = prepare_jpeg_bytes(buf.getvalue())
        self.assertIsNotNone(jpeg)
        self.assertGreater(len(jpeg), 32)

    def test_chip_jpeg_bytes_from_file(self):
        from tempfile import TemporaryDirectory

        with TemporaryDirectory(prefix="fit-stealer-") as tmp:
            path = Path(tmp) / "chip.jpg"
            path.write_bytes(jpeg_bytes())
            data = chip_jpeg_bytes(None, {"chip_key": str(path)})
            self.assertIsNotNone(data)

    def test_fetch_skips_private_urls(self):
        self.assertIsNone(fetch_product_image("http://127.0.0.1/secret.jpg"))
        self.assertIsNone(fetch_product_image("http://169.254.169.254/latest/meta-data"))
        self.assertIsNone(fetch_product_image("http://localhost/chip.jpg"))

    def test_fetch_skips_http_errors(self):
        import requests as req

        with patch("services.visual_judge.requests.get", side_effect=req.RequestException("404")):
            self.assertIsNone(fetch_product_image("https://cdn.example/missing.jpg"))

    def test_fetch_skips_html_bodies(self):
        response = Mock()
        response.raise_for_status.return_value = None
        response.status_code = 200
        response.is_redirect = False
        response.headers = {"Content-Type": "text/html"}
        response.content = b"<html>not an image</html>"
        with patch("services.visual_judge.requests.get", return_value=response):
            self.assertIsNone(fetch_product_image("https://example.com/page"))

    def test_private_hosts_are_blocked(self):
        self.assertFalse(is_public_http_url("http://127.0.0.1/a.jpg"))
        self.assertFalse(is_public_http_url("http://10.0.0.5/a.jpg"))
        self.assertFalse(is_public_http_url("http://192.168.1.9/a.jpg"))
        self.assertFalse(is_public_http_url("http://169.254.169.254/latest"))
        self.assertFalse(is_public_http_url("http://localhost/a.jpg"))
        self.assertTrue(is_public_http_url("http://8.8.8.8/a.jpg"))

    def test_fetch_backfills_after_broken_urls(self):
        urls = [f"https://cdn.example/{i}.jpg" for i in range(10)]
        candidates = [{"title": "J", "url": f"https://shop.example/{i}", "image_url": url} for i, url in enumerate(urls)]

        def fake_fetch(url: str, timeout: float = 3.5):
            index = int(url.rsplit("/", 1)[-1].split(".")[0])
            if index < 8:
                return None
            return jpeg_bytes((index, index, index))

        with patch("services.visual_judge.fetch_product_image", side_effect=fake_fetch):
            photos = fetch_candidate_images(candidates, limit=8)
        self.assertEqual([index for index, _jpeg in photos], [8, 9])


class JudgeTests(unittest.TestCase):
    def test_scores_keep_original_candidate_indexes(self):
        payload = {
            "scores": [
                {
                    "candidate_index": 2,
                    "label": "same_item",
                    "score": 0.91,
                    "reason": "Same silver zip and ribbed cuffs.",
                },
                {
                    "candidate_index": 99,
                    "label": "similar",
                    "score": 0.4,
                    "reason": "ignored index",
                },
            ]
        }
        client = Mock()
        client.chat.completions.create.return_value = SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps(payload)))]
        )
        photos = [(2, jpeg_bytes())]
        with patch("services.visual_judge.fetch_candidate_images", return_value=photos):
            scores = judge_candidates(jpeg_bytes(), [JACKET, JACKET, JACKET], GARMENT, client=client)
        self.assertEqual(len(scores), 1)
        self.assertEqual(scores[0]["candidate_index"], 2)
        self.assertEqual(scores[0]["score"], 0.91)
        self.assertEqual(client.chat.completions.create.call_args.kwargs["temperature"], 0)
        self.assertEqual(client.chat.completions.create.call_args.kwargs["seed"], 0)

    def test_skips_when_chip_missing(self):
        self.assertEqual(judge_candidates(None, [JACKET], GARMENT), [])


class RankerGateTests(unittest.TestCase):
    def test_exact_without_visual_score_is_demoted(self):
        result = rank_candidates(GARMENT, [JACKET], client=fake_rank_client("exact"))
        self.assertEqual(result[0]["match_type"], "similar")
        self.assertEqual(result[0]["reason"], DEMOTED_REASON)
        self.assertLessEqual(result[0]["confidence"], 0.74)

    def test_exact_kept_when_visual_score_is_high(self):
        visuals = [{"candidate_index": 0, "label": "same_item", "score": 0.91, "reason": "same zip"}]
        result = rank_candidates(
            GARMENT, [JACKET], client=fake_rank_client("exact"), visual_scores=visuals
        )
        self.assertEqual(result[0]["match_type"], "exact")
        self.assertEqual(result[0]["visual_score"], 0.91)
        self.assertGreaterEqual(result[0]["visual_score"], EXACT_VISUAL_THRESHOLD)

    def test_exact_demoted_when_category_disagrees(self):
        shoe = {"title": "Black Leather Sneakers", "url": "https://shop.example/shoe", "source": "shopify"}
        visuals = [{"candidate_index": 0, "label": "same_item", "score": 0.95, "reason": "black leather"}]
        result = rank_candidates(
            GARMENT, [shoe], client=fake_rank_client("exact"), visual_scores=visuals
        )
        self.assertEqual(result[0]["match_type"], "similar")

    def test_low_visual_score_cannot_be_exact(self):
        visuals = [{"candidate_index": 0, "label": "similar", "score": 0.6, "reason": "same color"}]
        result = rank_candidates(
            GARMENT, [JACKET], client=fake_rank_client("exact"), visual_scores=visuals
        )
        self.assertEqual(result[0]["match_type"], "similar")

    def test_fallback_never_claims_exact(self):
        result = fallback_rank_candidates(GARMENT, [JACKET])
        self.assertEqual(result[0]["match_type"], "similar")

    def test_high_score_similar_label_cannot_be_exact(self):
        visuals = [{"candidate_index": 0, "label": "similar", "score": 0.85, "reason": "same color"}]
        result = rank_candidates(
            GARMENT, [JACKET], client=fake_rank_client("exact"), visual_scores=visuals
        )
        self.assertEqual(result[0]["match_type"], "similar")
        self.assertEqual(result[0]["reason"], DEMOTED_REASON)

    def test_empty_title_does_not_agree(self):
        self.assertFalse(category_agrees(GARMENT, {"title": ""}))
        self.assertFalse(category_agrees(GARMENT, {}))

    def test_category_aliases_match_field_jacket(self):
        self.assertTrue(category_agrees(GARMENT, {"title": "Iver 4 Pocket Field Jacket"}))
        self.assertFalse(category_agrees(GARMENT, {"title": "Canvas Tote Bag"}))


class SourceVisionFallbackTests(unittest.TestCase):
    @patch("services.source_and_rank.browse_products", return_value=[])
    @patch("services.source_and_rank.rank_candidates")
    @patch("services.source_and_rank.judge_candidates", return_value=[])
    @patch("services.retrieval.search_shopify_catalog")
    def test_empty_visual_scores_use_similar_only_fallback(self, search, _judge, rank, _browse):
        search.return_value = [JACKET]
        rank.return_value = [{"match_type": "exact"}]
        result = source_and_rank(GARMENT, "YWJj")
        self.assertEqual(result[0]["match_type"], "similar")
        rank.assert_not_called()


if __name__ == "__main__":
    unittest.main()
