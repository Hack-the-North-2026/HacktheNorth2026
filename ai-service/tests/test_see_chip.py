from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from PIL import Image

AI_SERVICE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AI_SERVICE))

from fastapi.testclient import TestClient  # noqa: E402
from main import app  # noqa: E402
from services.query_normalize import unique_queries  # noqa: E402
from services.see_chip import (  # noqa: E402
    analyze_chip,
    detail_garments,
    enforce_brand,
    fallback_merge,
    merge_chip_into_garment,
)


SCENE = {
    "id": "jacket-05-06-15-11",
    "category": "jacket",
    "description": "black leather bomber jacket",
    "search_query": "black leather bomber jacket",
    "attributes": {"color": "black", "material": "leather", "pattern": None, "fit": "regular"},
    "brand": "Nike",
    "brand_cues": [],
    "confidence": 0.8,
    "bbox": [0.2, 0.2, 0.8, 0.7],
    "chip_key": "",
    "accessibility_line": "A black leather bomber jacket.",
}

CHIP = {
    "description": "black leather bomber with silver zip hardware and ribbed cuffs",
    "attributes": {
        "color": "black",
        "material": "leather",
        "pattern": None,
        "fit": "oversized",
    },
    "brand": None,
    "brand_cues": [],
    "primary_query": "black leather bomber jacket ribbed collar cuffs",
    "distinctive_query": "silver zip hardware ribbed cuffs bomber",
    "brand_query": None,
    "accessibility_line": "Black leather bomber with silver zips and ribbed cuffs.",
    "confidence": 0.92,
}


class BrandHonestyTests(unittest.TestCase):
    def test_nulls_brand_without_cues(self):
        cleaned = enforce_brand({"brand": "Nike", "brand_cues": ["", "  "]})
        self.assertIsNone(cleaned["brand"])
        self.assertEqual(cleaned["brand_cues"], [])

    def test_keeps_brand_when_cue_is_readable(self):
        cleaned = enforce_brand({"brand": "Levi's", "brand_cues": ["red tab logo"]})
        self.assertEqual(cleaned["brand"], "Levi's")
        self.assertEqual(cleaned["brand_cues"], ["red tab logo"])


class FallbackMergeTests(unittest.TestCase):
    def test_chip_overwrites_scene_and_drops_hallucinated_brand(self):
        merged = fallback_merge(SCENE, CHIP)
        self.assertIn("silver zip hardware", merged["description"])
        self.assertIsNone(merged["brand"])
        self.assertEqual(merged["search_query"], "black leather bomber jacket ribbed collar cuffs")
        self.assertEqual(
            merged["queries"][0],
            "black leather bomber jacket ribbed collar cuffs",
        )
        self.assertIn("silver zip hardware ribbed cuffs bomber", merged["queries"])
        self.assertGreater(len(merged["description"]), len(SCENE["description"]))

    def test_brand_query_only_when_cues_exist(self):
        chip = dict(CHIP)
        chip["brand"] = "Schott"
        chip["brand_cues"] = ["Schott NYC collar stamp"]
        chip["brand_query"] = "Schott black leather bomber jacket"
        merged = fallback_merge(SCENE, chip)
        self.assertEqual(merged["brand"], "Schott")
        self.assertTrue(any("schott" in query for query in merged["queries"]))

    def test_unique_queries_drops_duplicates(self):
        self.assertEqual(
            unique_queries("Grey leather jacket", "grey leather jacket", "silver zip hardware"),
            ["gray leather jacket", "silver zip hardware"],
        )


class SeeChipCallTests(unittest.TestCase):
    def test_analyze_chip_uses_temperature_zero(self):
        with tempfile.TemporaryDirectory() as tmp:
            chip_path = Path(tmp) / "jacket.jpg"
            Image.new("RGB", (64, 64), (10, 10, 10)).save(chip_path, "JPEG")
            fake = Mock()
            fake.chat.completions.create.return_value = SimpleNamespace(
                choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps(CHIP)))]
            )
            result = analyze_chip(str(chip_path), "jacket", client=fake)
        kwargs = fake.chat.completions.create.call_args.kwargs
        self.assertEqual(kwargs["temperature"], 0)
        self.assertEqual(kwargs["seed"], 0)
        self.assertIsNone(result["brand"])
        image_block = kwargs["messages"][1]["content"][1]
        self.assertEqual(image_block["type"], "image_url")

    def test_openai_merge_keeps_trusted_chip_details(self):
        ranking = {
            "description": "black leather bomber with silver zip hardware and ribbed cuffs",
            "attributes": CHIP["attributes"],
            "brand": None,
            "brand_cues": [],
            "search_query": "black leather bomber jacket silver zip hardware",
            "queries": [
                "black leather bomber jacket silver zip hardware",
                "silver zip hardware ribbed cuffs bomber",
            ],
            "accessibility_line": "Black leather bomber with silver zips.",
        }
        fake = Mock()
        fake.chat.completions.create.return_value = SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps(ranking)))]
        )
        merged = merge_chip_into_garment(SCENE, CHIP, client=fake)
        kwargs = fake.chat.completions.create.call_args.kwargs
        self.assertEqual(kwargs["temperature"], 0)
        self.assertEqual(kwargs["seed"], 0)
        self.assertIsNone(merged["brand"])
        self.assertIn("silver zip", merged["description"])
        self.assertEqual(merged["search_query"], "black leather bomber jacket silver zip hardware")

    def test_missing_chip_keeps_scene_query(self):
        result = detail_garments([dict(SCENE)])
        self.assertEqual(result[0]["search_query"], "black leather bomber jacket")
        self.assertIsNone(result[0]["brand"])


class SeeChipEndpointTests(unittest.TestCase):
    @patch("main.detail_garments")
    def test_route_returns_detailed_garments(self, detail):
        detailed = dict(SCENE)
        detailed["description"] = CHIP["description"]
        detailed["search_query"] = CHIP["primary_query"]
        detailed["queries"] = [CHIP["primary_query"], CHIP["distinctive_query"]]
        detail.return_value = [detailed]
        response = TestClient(app).post("/tools/see-chip", json={"garments": [SCENE]})
        self.assertEqual(response.status_code, 200)
        body = response.json()["garments"][0]
        self.assertIn("silver zip hardware", body["description"])
        detail.assert_called_once()

    def test_health_lists_see_chip(self):
        response = TestClient(app).get("/health")
        self.assertIn("/tools/see-chip", response.json()["endpoints"])


if __name__ == "__main__":
    unittest.main()
