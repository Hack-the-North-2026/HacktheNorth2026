from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

AI_SERVICE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AI_SERVICE))

from services.composio_shopping import (  # noqa: E402
    extract_shopping_items,
    normalize_shopping_item,
    search_composio_shopping,
)
from services.query_normalize import garment_catalog_queries, like_query  # noqa: E402
from services.retrieval import (  # noqa: E402
    canonical_product_url,
    dedupe_candidates,
    retrieve_candidates,
    shopify_search_jobs,
)
from services.shopify_filter import search_shopify_catalog  # noqa: E402
from services.source_and_rank import source_and_rank  # noqa: E402


GARMENT = {
    "id": "jacket-05-06-15-11",
    "category": "jacket",
    "description": "black leather bomber with silver zip hardware",
    "search_query": "black leather bomber jacket ribbed collar cuffs",
    "queries": [
        "black leather bomber jacket ribbed collar cuffs",
        "silver zip hardware ribbed cuffs bomber",
        "schott leather bomber",
    ],
    "attributes": {"color": "black", "material": "leather", "fit": "oversized"},
    "brand": None,
    "brand_cues": [],
}


def product(url: str, title: str = "Jacket", source: str = "shopify", image: str | None = None) -> dict:
    item = {"title": title, "url": url, "source": source}
    if image:
        item["image_url"] = image
    return item


class QueryPlanTests(unittest.TestCase):
    def test_like_query_is_color_material_category(self):
        self.assertEqual(like_query(GARMENT, GARMENT["search_query"]), "black leather jacket")

    def test_catalog_queries_keep_chip_order(self):
        self.assertEqual(
            garment_catalog_queries(GARMENT)[:2],
            [
                "black leather bomber jacket ribbed collar cuffs",
                "silver zip hardware ribbed cuffs bomber",
            ],
        )

    def test_jobs_are_primary_distinctive_like(self):
        jobs = shopify_search_jobs(GARMENT, "YWJj")
        self.assertEqual([job["kind"] for job in jobs], ["primary", "distinctive", "like"])
        self.assertFalse(jobs[0]["use_like"])
        self.assertFalse(jobs[1]["use_like"])
        self.assertTrue(jobs[2]["use_like"])
        self.assertEqual(jobs[2]["query"], "black leather jacket")
        self.assertNotEqual(jobs[0]["query"], jobs[1]["query"])

    def test_jobs_without_chip_skip_like_search(self):
        jobs = shopify_search_jobs(GARMENT, None)
        self.assertEqual([job["kind"] for job in jobs], ["primary", "distinctive", "brand"])
        self.assertTrue(all(not job["use_like"] for job in jobs))
        self.assertIn("schott", jobs[2]["query"])


class DedupeTests(unittest.TestCase):
    def test_canonical_url_strips_tracking(self):
        self.assertEqual(
            canonical_product_url("https://Shop.Example/Jacket/?utm_source=ig&variant=1"),
            "https://shop.example/Jacket?variant=1",
        )
        self.assertEqual(
            canonical_product_url("https://shop.example/Jacket?variant=1"),
            canonical_product_url("https://Shop.Example/Jacket/?utm_source=ig&variant=1"),
        )

    def test_dedupe_keeps_shopify_over_composio(self):
        kept = dedupe_candidates(
            [
                product("https://shop.example/j?utm_campaign=x", "Composio Jacket", "composio"),
                product("https://shop.example/j", "Shopify Jacket", "shopify", "https://cdn.example/j.jpg"),
            ]
        )
        self.assertEqual(len(kept), 1)
        self.assertEqual(kept[0]["source"], "shopify")
        self.assertEqual(kept[0]["title"], "Shopify Jacket")


class FanoutTests(unittest.TestCase):
    @patch("services.retrieval.search_composio_shopping")
    @patch("services.retrieval.search_shopify_catalog")
    def test_three_parallel_shopify_queries_dedupe_urls(self, search, composio):
        def fake_search(_garment, chip=None, query=None, use_like=None, **_kwargs):
            if query and "silver zip" in query:
                return [product("https://shop.example/b", "Distinctive Jacket")]
            if use_like:
                return [
                    product("https://shop.example/a?utm_source=ig", "Like Duplicate"),
                    product("https://shop.example/c", "Like Jacket", image="https://cdn.example/c.jpg"),
                ]
            return [product("https://shop.example/a", "Primary Jacket", image="https://cdn.example/a.jpg")]

        search.side_effect = fake_search
        composio.return_value = []
        with patch.dict("os.environ", {"COMPOSIO_API_KEY": "", "COMPOSIO_SHOPPING": "off"}, clear=False):
            result = retrieve_candidates(GARMENT, "YWJj")
        self.assertEqual(search.call_count, 3)
        by_query = {call.kwargs["query"]: call for call in search.call_args_list}
        self.assertIn("black leather bomber jacket ribbed collar cuffs", by_query)
        self.assertIn("silver zip hardware ribbed cuffs bomber", by_query)
        self.assertIn("black leather jacket", by_query)
        self.assertFalse(by_query["black leather bomber jacket ribbed collar cuffs"].kwargs.get("use_like"))
        like_call = by_query["black leather jacket"]
        self.assertTrue(like_call.kwargs.get("use_like"))
        self.assertEqual(like_call.args[1], "YWJj")
        self.assertIsNone(by_query["black leather bomber jacket ribbed collar cuffs"].args[1])
        self.assertEqual(len(result), 3)
        self.assertTrue(result[0].get("image_url"))
        composio.assert_not_called()

    @patch("services.retrieval.search_composio_shopping")
    @patch("services.retrieval.search_shopify_catalog")
    def test_thin_shopify_calls_composio(self, search, composio):
        search.return_value = [product("https://shop.example/only")]
        composio.return_value = [
            product("https://google.example/found", "Shopping Jacket", "composio", "https://cdn.example/c.jpg")
        ]
        with patch.dict(
            "os.environ",
            {"COMPOSIO_API_KEY": "test-key", "COMPOSIO_SHOPPING": "auto"},
            clear=False,
        ):
            result = retrieve_candidates(GARMENT, "YWJj")
        composio.assert_called_once()
        sources = {item["source"] for item in result}
        self.assertIn("composio", sources)
        self.assertIn("shopify", sources)

    @patch("services.retrieval.search_composio_shopping")
    @patch("services.retrieval.search_shopify_catalog")
    def test_rich_shopify_skips_composio(self, search, composio):
        search.side_effect = [
            [product(f"https://shop.example/{i}") for i in range(4)],
            [product("https://shop.example/4")],
            [product("https://shop.example/5")],
        ]
        with patch.dict("os.environ", {"COMPOSIO_API_KEY": "test-key", "COMPOSIO_SHOPPING": "auto"}, clear=False):
            result = retrieve_candidates(GARMENT, "YWJj")
        composio.assert_not_called()
        self.assertGreaterEqual(len(result), 4)

    @patch("services.retrieval.search_composio_shopping", return_value=[])
    @patch("services.retrieval.search_shopify_catalog", side_effect=RuntimeError("boom"))
    def test_shopify_exceptions_do_not_raise(self, _search, _composio):
        self.assertEqual(retrieve_candidates(GARMENT, "YWJj"), [])
        self.assertEqual(source_and_rank(GARMENT, "YWJj"), [])


class ShopifyQueryOverrideTests(unittest.TestCase):
    def test_query_override_and_like_opt_out(self):
        response = Mock()
        response.raise_for_status.return_value = None
        response.json.return_value = {"result": {"structuredContent": {"products": []}}}
        session = Mock()
        session.post.return_value = response
        search_shopify_catalog(
            GARMENT,
            "YWJj",
            query="black leather jacket",
            use_like=False,
            session=session,
        )
        catalog = session.post.call_args.kwargs["json"]["params"]["arguments"]["catalog"]
        self.assertEqual(catalog["query"], "black leather jacket")
        self.assertNotIn("like", catalog)


class ComposioParseTests(unittest.TestCase):
    def test_extracts_google_shopping_shape(self):
        payload = {
            "successful": True,
            "data": {
                "shopping_results": [
                    {
                        "title": "Schott Leather Bomber",
                        "link": "https://store.example/schott",
                        "source": "Schott NYC",
                        "extracted_price": 890,
                        "thumbnail": "https://cdn.example/schott.jpg",
                    }
                ]
            },
        }
        items = extract_shopping_items(payload)
        candidate = normalize_shopping_item(items[0])
        self.assertEqual(candidate["source"], "composio")
        self.assertEqual(candidate["url"], "https://store.example/schott")
        self.assertEqual(candidate["price"], "890.00")
        self.assertEqual(candidate["image_url"], "https://cdn.example/schott.jpg")
        self.assertEqual(candidate["store_name"], "Schott NYC")

    def test_unconfigured_returns_empty(self):
        with patch.dict("os.environ", {"COMPOSIO_API_KEY": "", "COMPOSIO_SHOPPING": "auto"}, clear=False):
            self.assertEqual(search_composio_shopping(GARMENT), [])


if __name__ == "__main__":
    unittest.main()
