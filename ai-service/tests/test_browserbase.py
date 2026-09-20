from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

AI_SERVICE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AI_SERVICE))

from services.browserbase_scraper import (  # noqa: E402
    _is_dead_result_page,
    normalize_browserbase_product,
    search_products_with_browserbase,
    should_browse,
)
from services.source_and_rank import source_and_rank  # noqa: E402
from services.visual_judge import WEAK_VISUAL_THRESHOLD, best_visual_score  # noqa: E402


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

GRAILED = {
    "title": "Schott Perfecto Leather Jacket",
    "url": "https://www.grailed.com/listings/123-schott-perfecto",
    "image_url": "https://cdn.grailed.com/schott.jpg",
    "price": "$420",
    "store_name": "Grailed",
}


class ShouldBrowseTests(unittest.TestCase):
    def test_skips_when_disabled(self):
        with patch.dict("os.environ", {"BROWSERBASE": "off", "BROWSERBASE_API_KEY": "k"}, clear=False):
            self.assertFalse(should_browse([{"score": 0.1}], [JACKET]))

    def test_skips_when_visual_is_strong(self):
        with patch.dict("os.environ", {"BROWSERBASE": "auto", "BROWSERBASE_API_KEY": "k"}, clear=False):
            self.assertFalse(should_browse([{"score": 0.84, "label": "same_item"}], [JACKET]))
            self.assertGreater(0.84, WEAK_VISUAL_THRESHOLD)

    def test_runs_when_visual_is_weak_or_missing(self):
        with patch.dict("os.environ", {"BROWSERBASE": "auto", "BROWSERBASE_API_KEY": "k"}, clear=False):
            self.assertTrue(should_browse([{"score": 0.41}], [JACKET]))
            self.assertTrue(should_browse([], [JACKET]))
            self.assertTrue(should_browse([{"score": 0.9}], []))


class NormalizeTests(unittest.TestCase):
    def test_maps_extract_shape(self):
        candidate = normalize_browserbase_product(GRAILED)
        self.assertEqual(candidate["source"], "browserbase")
        self.assertEqual(candidate["url"], GRAILED["url"])
        self.assertEqual(candidate["price"], "420.00")
        self.assertEqual(candidate["image_url"], GRAILED["image_url"])

    def test_drops_search_engine_urls(self):
        self.assertIsNone(
            normalize_browserbase_product(
                {"title": "Jacket", "url": "https://www.google.com/search?q=jacket"}
            )
        )

    def test_skips_bing_marketing_pages(self):
        self.assertTrue(
            _is_dead_result_page(
                "https://explore.microsoft.com/en-us/bing/visual-search/?cs=3157006563&form=MT016O"
            )
        )
        self.assertFalse(_is_dead_result_page("https://www.google.com/search?tbm=shop&q=jacket"))
        self.assertFalse(_is_dead_result_page("https://www.grailed.com/shop?query=jacket"))


class SearchEntryTests(unittest.TestCase):
    def test_unconfigured_is_noop(self):
        with patch.dict("os.environ", {"BROWSERBASE_API_KEY": "", "BROWSERBASE": "auto"}, clear=False):
            self.assertEqual(search_products_with_browserbase(GARMENT), [])


class SourceBrowseTests(unittest.TestCase):
    @patch("services.source_and_rank.rank_candidates")
    @patch("services.source_and_rank.browse_products")
    @patch("services.source_and_rank.judge_candidates")
    @patch("services.retrieval.search_shopify_catalog")
    def test_strong_visual_skips_browserbase(self, search, judge, browse, rank):
        search.return_value = [JACKET]
        judge.return_value = [{"candidate_index": 0, "label": "same_item", "score": 0.91, "reason": "same zip"}]
        rank.return_value = [{**JACKET, "match_type": "exact"}]
        with patch.dict("os.environ", {"BROWSERBASE": "auto", "BROWSERBASE_API_KEY": "k"}, clear=False):
            source_and_rank(GARMENT, "YWJj")
        browse.assert_not_called()
        judge.assert_called_once()

    @patch("services.source_and_rank.rank_candidates")
    @patch("services.source_and_rank.browse_products")
    @patch("services.source_and_rank.judge_candidates")
    @patch("services.retrieval.search_shopify_catalog")
    def test_weak_visual_browses_and_rejudges(self, search, judge, browse, rank):
        search.return_value = [JACKET]
        grailed = {
            "title": GRAILED["title"],
            "url": GRAILED["url"],
            "image_url": GRAILED["image_url"],
            "source": "browserbase",
        }
        browse.return_value = [grailed]
        judge.side_effect = [
            [{"candidate_index": 0, "label": "similar", "score": 0.4, "reason": "weak"}],
            [
                {"candidate_index": 0, "label": "same_item", "score": 0.9, "reason": "grailed match"},
                {"candidate_index": 1, "label": "similar", "score": 0.4, "reason": "shopify"},
            ],
        ]
        rank.return_value = [{**grailed, "match_type": "exact"}]
        with patch.dict("os.environ", {"BROWSERBASE": "auto", "BROWSERBASE_API_KEY": "k"}, clear=False):
            result = source_and_rank(GARMENT, "YWJj")
        browse.assert_called_once()
        self.assertEqual(judge.call_count, 2)
        merged = judge.call_args_list[1].args[1]
        urls = [item["url"] for item in merged]
        self.assertIn(GRAILED["url"], urls)
        self.assertIn(JACKET["url"], urls)
        rank.assert_called_once()
        self.assertEqual(result[0]["source"], "browserbase")

    def test_best_visual_score_helper(self):
        self.assertEqual(best_visual_score([{"score": 0.4}, {"score": 0.71}]), 0.71)
        self.assertIsNone(best_visual_score([]))


if __name__ == "__main__":
    unittest.main()
