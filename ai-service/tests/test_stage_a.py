from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from PIL import Image

AI_SERVICE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AI_SERVICE))

from services.baseten_vlm import analyze_frames_with_vlm, stable_garment_id  # noqa: E402
from services.cropper import MAX_CHIP_COVERAGE, crop_garments, managed_media_path, pad_pixel_box  # noqa: E402
from services.query_normalize import canonicalize_query  # noqa: E402
from services.shopify_filter import search_shopify_catalog  # noqa: E402


GARMENT = {
    "id": "jacket-1",
    "category": "jacket",
    "description": "The oversized grey leather jacket with a silver zip",
    "search_query": "The Oversized Grey Leather Jacket with a Silver Zip",
    "attributes": {"color": "grey", "material": "leather", "fit": "oversized"},
    "brand": None,
    "brand_cues": [],
}


class QueryCanonicalizeTests(unittest.TestCase):
    def test_lowercases_aliases_colors_and_drops_filler(self):
        self.assertEqual(
            canonicalize_query("The Oversized Grey Leather Jacket with a Silver Zip"),
            "oversized gray leather jacket silver zip",
        )
        self.assertEqual(canonicalize_query("navy blue wide-leg trousers"), "navy wide-leg trousers")
        self.assertEqual(canonicalize_query("off-white fleece pullover"), "off-white fleece pullover")

    def test_is_idempotent(self):
        query = canonicalize_query("A very cool maroon bomber jacket")
        self.assertEqual(canonicalize_query(query), query)
        self.assertEqual(query, "burgundy bomber jacket")


class StableIdTests(unittest.TestCase):
    def test_same_category_and_bbox_same_id(self):
        used = set()
        first = stable_garment_id("jacket", [0.11, 0.20, 0.71, 0.88], used)
        second = stable_garment_id("jacket", [0.12, 0.21, 0.70, 0.89], set())
        self.assertEqual(first, second)
        self.assertTrue(first.startswith("jacket-"))

    def test_quantization_is_stable_across_small_drift(self):
        self.assertEqual(
            stable_garment_id("pants", [0.24, 0.40, 0.55, 0.90]),
            stable_garment_id("pants", [0.26, 0.41, 0.54, 0.91]),
        )

    def test_collisions_get_a_suffix(self):
        used = set()
        first = stable_garment_id("bag", [0.1, 0.1, 0.2, 0.2], used)
        second = stable_garment_id("bag", [0.1, 0.1, 0.2, 0.2], used)
        self.assertEqual(second, f"{first}-2")


class CropperStageATests(unittest.TestCase):
    def test_pads_bbox_by_ten_percent(self):
        self.assertEqual(pad_pixel_box(50, 50, 150, 150, 200, 200), (40, 40, 160, 160))

    def test_skips_full_person_chip_but_keeps_garment(self):
        with tempfile.TemporaryDirectory() as tmp:
            image_path = Path(tmp) / "scene.jpg"
            Image.new("RGB", (100, 200), (30, 30, 30)).save(image_path, "JPEG")
            garments = [
                {
                    "id": "jacket-00-00-20-20",
                    "category": "jacket",
                    "bbox": [0.0, 0.0, 1.0, 1.0],
                }
            ]
            result = crop_garments(str(image_path), garments, tmp)
            self.assertEqual(result[0]["chip_key"], "")
            self.assertGreaterEqual(1.0, MAX_CHIP_COVERAGE)


    def test_managed_media_path_rejects_unrelated_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            other = Path(tmp) / "secret.jpg"
            other.write_bytes(b"not-a-chip")
            self.assertIsNone(managed_media_path(str(other)))
        with tempfile.TemporaryDirectory(prefix="fit-stealer-") as tmp:
            chip = Path(tmp) / "jacket.jpg"
            chip.write_bytes(b"x" * 40)
            self.assertEqual(managed_media_path(str(chip)), chip.resolve())
        self.assertIsNone(managed_media_path("/etc/passwd"))

    def test_padded_crop_is_larger_than_raw_bbox(self):
        with tempfile.TemporaryDirectory() as tmp:
            image_path = Path(tmp) / "scene.jpg"
            Image.new("RGB", (200, 200), (200, 180, 160)).save(image_path, "JPEG")
            garments = [
                {
                    "id": "shirt-05-05-15-15",
                    "category": "shirt",
                    "bbox": [0.25, 0.25, 0.75, 0.75],
                }
            ]
            result = crop_garments(str(image_path), garments, tmp)
            chip = Path(result[0]["chip_key"])
            self.assertTrue(chip.is_file())
            self.assertEqual(chip.name, "shirt-05-05-15-15.jpg")
            with Image.open(chip) as cropped:
                self.assertEqual(cropped.size, (120, 120))


class ShopifyLimitTests(unittest.TestCase):
    def test_catalog_requests_ten_products(self):
        response = Mock()
        response.raise_for_status.return_value = None
        response.json.return_value = {"result": {"structuredContent": {"products": []}}}
        session = Mock()
        session.post.return_value = response
        search_shopify_catalog(GARMENT, session=session)
        catalog = session.post.call_args.kwargs["json"]["params"]["arguments"]["catalog"]
        self.assertEqual(catalog["pagination"]["limit"], 10)


class SeeTemperatureTests(unittest.TestCase):
    @patch("services.baseten_vlm.OpenAI")
    @patch.dict("os.environ", {"BASETEN_API_KEY": "test-key"}, clear=False)
    def test_vlm_uses_temperature_zero_and_stable_ids(self, openai_cls):
        payload = {
            "garments": [
                {
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
                }
            ],
            "outfit_summary": "Street leather look",
        }
        openai_cls.return_value.chat.completions.create.return_value = SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=__import__("json").dumps(payload)))]
        )
        with tempfile.TemporaryDirectory() as tmp:
            image_path = Path(tmp) / "frame.jpg"
            Image.new("RGB", (64, 64), (10, 10, 10)).save(image_path, "JPEG")
            result = analyze_frames_with_vlm([str(image_path)])
        kwargs = openai_cls.return_value.chat.completions.create.call_args.kwargs
        self.assertEqual(kwargs["temperature"], 0)
        self.assertEqual(kwargs["seed"], 0)
        garment = result["garments"][0]
        self.assertEqual(garment["id"], stable_garment_id("jacket", [0.12, 0.20, 0.71, 0.88]))
        self.assertNotEqual(garment["id"], "random-from-model")
        self.assertEqual(garment["search_query"], "oversized gray leather jacket silver zip")


if __name__ == "__main__":
    unittest.main()
