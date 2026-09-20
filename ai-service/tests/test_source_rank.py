from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import requests


AI_SERVICE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AI_SERVICE))

from services.product_ranker import fallback_rank_candidates, rank_candidates  # noqa: E402
from services.shopify_filter import (  # noqa: E402
    ShopifyCatalogError,
    normalize_product,
    search_shopify_catalog,
)
from services.source_and_rank import source_and_rank  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from main import app  # noqa: E402


GARMENT = {
    "id": "jacket-1",
    "category": "jacket",
    "description": "oversized black leather biker jacket",
    "search_query": "oversized black leather biker jacket silver hardware",
    "attributes": {"color": "black", "material": "leather", "fit": "oversized"},
    "brand": None,
    "brand_cues": [],
}


class ShopifyTests(unittest.TestCase):
    def test_normalizes_ucp_minor_price(self):
        candidate = normalize_product(
            {
                "title": "Black Leather Jacket",
                "url": "https://shop.example/jacket",
                "price_range": {"min": {"amount": 14999, "currency": "cad"}},
                "media": [{"url": "https://cdn.example/jacket.jpg"}],
                "merchant": {"name": "Example Store"},
            }
        )
        self.assertEqual(candidate["price"], "149.99")
        self.assertEqual(candidate["currency"], "CAD")
        self.assertEqual(candidate["source"], "shopify")

    def test_catalog_request_uses_text_image_and_context(self):
        response = Mock()
        response.raise_for_status.return_value = None
        response.json.return_value = {
            "result": {
                "structuredContent": {
                    "products": [
                        {"title": "Biker Jacket", "url": "https://shop.example/p/1"}
                    ]
                }
            }
        }
        session = Mock()
        session.post.return_value = response
        results = search_shopify_catalog(GARMENT, "YWJj", session=session)
        self.assertEqual(len(results), 1)
        body = session.post.call_args.kwargs["json"]
        catalog = body["params"]["arguments"]["catalog"]
        self.assertEqual(catalog["query"], GARMENT["search_query"])
        self.assertEqual(catalog["like"][0]["image"]["data"], "YWJj")
        self.assertEqual(catalog["context"]["currency"], "CAD")
        self.assertEqual(catalog["pagination"]["limit"], 10)

    def test_normalizes_real_catalog_variant_shape(self):
        candidate = normalize_product(
            {
                "title": "Biker Jacket",
                "media": [{"type": "image", "url": "https://cdn.example/jacket.jpg"}],
                "variants": [
                    {
                        "url": "https://shop.example/products/jacket?variant=1",
                        "price": {"amount": 14200, "currency": "CAD"},
                        "availability": {"available": True},
                        "seller": {"name": "Jacket Shop"},
                    }
                ],
                "price_range": {
                    "min": {"amount": 14200, "currency": "CAD"},
                    "max": {"amount": 14200, "currency": "CAD"},
                },
            }
        )
        self.assertEqual(candidate["url"], "https://shop.example/products/jacket?variant=1")
        self.assertEqual(candidate["price"], "142.00")
        self.assertEqual(candidate["store_name"], "Jacket Shop")

    def test_protocol_error_is_recoverable(self):
        response = Mock()
        response.raise_for_status.return_value = None
        response.json.return_value = {"error": {"message": "invalid profile"}}
        session = Mock()
        session.post.return_value = response
        with self.assertRaises(ShopifyCatalogError):
            search_shopify_catalog(GARMENT, session=session)

    @patch("services.shopify_filter.time.sleep")
    def test_http_429_retries_once(self, sleep):
        limited = Mock()
        limited.raise_for_status.side_effect = requests.HTTPError("429 Too Many Requests")
        recovered = Mock()
        recovered.raise_for_status.return_value = None
        recovered.json.return_value = {
            "result": {
                "structuredContent": {
                    "products": [
                        {"title": "Recovered After 429", "url": "https://shop.example/recovered-429"}
                    ]
                }
            }
        }
        session = Mock()
        session.post.side_effect = [limited, recovered]
        result = search_shopify_catalog(GARMENT, session=session)
        self.assertEqual(result[0]["title"], "Recovered After 429")
        self.assertEqual(session.post.call_count, 2)
        sleep.assert_called_once()

    @patch("services.shopify_filter.time.sleep")
    def test_transient_catalog_error_retries_once(self, sleep):
        failed = Mock()
        failed.raise_for_status.return_value = None
        failed.json.return_value = {"error": {"message": "Service error. Try again later."}}
        recovered = Mock()
        recovered.raise_for_status.return_value = None
        recovered.json.return_value = {
            "result": {
                "structuredContent": {
                    "products": [
                        {"title": "Recovered Jacket", "url": "https://shop.example/recovered"}
                    ]
                }
            }
        }
        session = Mock()
        session.post.side_effect = [failed, recovered]
        result = search_shopify_catalog(GARMENT, session=session)
        self.assertEqual(result[0]["title"], "Recovered Jacket")
        self.assertEqual(session.post.call_count, 2)
        sleep.assert_called_once()


class RankerTests(unittest.TestCase):
    def test_model_selects_indexes_without_rewriting_products(self):
        candidate = {
            "title": "Trusted title",
            "url": "https://shop.example/trusted",
            "source": "shopify",
        }
        ranking = {
            "matches": [
                {
                    "candidate_index": 0,
                    "match_type": "similar",
                    "confidence": 0.85,
                    "reason": "Same material and biker silhouette.",
                },
                {
                    "candidate_index": 99,
                    "match_type": "exact",
                    "confidence": 1,
                    "reason": "Invalid index must be ignored.",
                },
            ]
        }
        fake_client = Mock()
        fake_client.chat.completions.create.return_value = SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps(ranking)))]
        )
        result = rank_candidates(GARMENT, [candidate], client=fake_client)
        self.assertEqual(result[0]["url"], candidate["url"])
        self.assertEqual(result[0]["match_type"], "similar")
        self.assertEqual(len(result), 1)
        kwargs = fake_client.chat.completions.create.call_args.kwargs
        self.assertEqual(kwargs["temperature"], 0)
        self.assertEqual(kwargs["seed"], 0)

    def test_fallback_never_claims_exact(self):
        candidates = [
            {
                "title": "Oversized Black Leather Biker Jacket",
                "url": "https://shop.example/jacket",
                "source": "shopify",
            }
        ]
        result = fallback_rank_candidates(GARMENT, candidates)
        self.assertEqual(result[0]["match_type"], "similar")

    @patch("services.source_and_rank.browse_products", return_value=[])
    @patch("services.retrieval.search_shopify_catalog")
    def test_shopify_failure_does_not_crash_outfit(self, search, _browse):
        search.side_effect = ShopifyCatalogError("timeout")
        self.assertEqual(source_and_rank(GARMENT), [])

    @patch("services.source_and_rank.browse_products", return_value=[])
    @patch("services.source_and_rank.rank_candidates")
    @patch("services.retrieval.search_shopify_catalog")
    def test_accepts_large_base64_without_treating_it_as_a_path(self, search, rank, _browse):
        encoded = "Y" * 5000
        search.return_value = []
        rank.return_value = []
        self.assertEqual(source_and_rank(GARMENT, encoded), [])
        chip_args = []
        for call in search.call_args_list:
            args, kwargs = call
            chip_args.append(args[1] if len(args) > 1 else kwargs.get("chip_base64"))
        self.assertIn(encoded, chip_args)


class SourceRankEndpointTests(unittest.TestCase):
    @patch("main.source_and_rank")
    def test_dev2_chip_contract_reaches_source_rank(self, source_rank):
        source_rank.return_value = [
            {
                "title": "Biker Jacket",
                "url": "https://shop.example/jacket",
                "source": "shopify",
                "match_type": "similar",
                "confidence": 0.9,
                "reason": "Same black leather biker silhouette.",
            }
        ]
        response = TestClient(app).post(
            "/tools/source-rank",
            json={
                "garment": GARMENT,
                "chip": {"content_type": "image/jpeg", "data": "YWJj"},
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["matches"][0]["match_type"], "similar")
        source_rank.assert_called_once_with(GARMENT, "YWJj")

    def test_probe_body_proves_route_exists(self):
        response = TestClient(app).post("/tools/source-rank", json={})
        self.assertEqual(response.status_code, 422)


if __name__ == "__main__":
    unittest.main()
