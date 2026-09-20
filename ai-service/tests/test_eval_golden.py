from __future__ import annotations

import sys
import unittest
from pathlib import Path

AI_SERVICE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AI_SERVICE))

from evals.metrics import (  # noqa: E402
    canonical_url,
    diagnose_fail_stage,
    jaccard,
    pairwise_jaccard,
    score_case,
    summarize,
)
from evals.run_golden import evaluate, load_manifest  # noqa: E402


class MetricsTests(unittest.TestCase):
    def test_jaccard_identical_and_empty(self):
        self.assertEqual(jaccard({"a", "b"}, {"b", "a"}), 1.0)
        self.assertEqual(jaccard(set(), set()), 1.0)
        self.assertEqual(jaccard({"a"}, {"a", "b"}), 0.5)

    def test_canonical_url_strips_tracking(self):
        self.assertEqual(
            canonical_url("https://Shop.Example/J?utm_source=x"),
            "https://shop.example/J",
        )

    def test_fail_stage_seechip_retrieve_judge_rank(self):
        self.assertIsNone(diagnose_fail_stage({"items": []}))
        self.assertEqual(
            diagnose_fail_stage(
                {
                    "items": [
                        {
                            "garment": {"id": "x", "category": "jacket"},
                            "matches": [{"match_type": "similar", "url": "https://s.example/a"}],
                        }
                    ]
                }
            ),
            "seechip",
        )
        self.assertEqual(
            diagnose_fail_stage(
                {
                    "items": [
                        {
                            "garment": {"id": "x", "search_query": "black jacket", "queries": ["black jacket"]},
                            "matches": [],
                        }
                    ]
                }
            ),
            "retrieve",
        )
        self.assertEqual(
            diagnose_fail_stage(
                {
                    "items": [
                        {
                            "garment": {"id": "x", "search_query": "black jacket"},
                            "matches": [{"match_type": "similar", "url": "https://s.example/a"}],
                        }
                    ]
                }
            ),
            "judge",
        )
        self.assertEqual(
            diagnose_fail_stage(
                {
                    "items": [
                        {
                            "garment": {"id": "x", "search_query": "black jacket"},
                            "matches": [
                                {
                                    "match_type": "similar",
                                    "url": "https://s.example/a",
                                    "visual_score": 0.9,
                                }
                            ],
                        }
                    ]
                }
            ),
            "rank",
        )

    def test_unstable_runs_fail_jaccard(self):
        run_a = {"items": [{"garment": {"id": "jacket-1"}, "matches": [{"url": "https://a.example/1"}]}]}
        run_b = {"items": [{"garment": {"id": "pants-1"}, "matches": [{"url": "https://a.example/2"}]}]}
        self.assertLess(pairwise_jaccard([run_a, run_b]), 1.0)
        scored = score_case({"id": "drift", "expect_empty": False}, [run_a, run_b, run_a])
        self.assertFalse(scored["ok"])


class GoldenSetTests(unittest.TestCase):
    def test_manifest_has_ten_cases_covering_kinds(self):
        cases = load_manifest()
        self.assertEqual(len(cases), 10)
        kinds = {case["kind"] for case in cases}
        self.assertTrue({"distinctive_jacket", "logo", "generic_tee", "no_clothes"} <= kinds)
        self.assertTrue(any(case.get("expect_empty") for case in cases))

    def test_recorded_fixtures_keep_the_scorer_honest(self):
        report = evaluate()
        summary = report["summary"]
        self.assertEqual(summary["cases"], 10)
        self.assertEqual(summary["stable_cases"], 10)
        self.assertGreater(summary["exact_rate"], 0)
        self.assertFalse(summary["zero_exact"])
        empty = next(row for row in report["rows"] if row["id"] == "no-clothes")
        self.assertTrue(empty["ok"])
        jacket = next(row for row in report["rows"] if row["id"] == "distinctive-leather-jacket")
        self.assertEqual(jacket["jaccard"], 1.0)
        self.assertTrue(jacket["top_url_stable"])
        self.assertGreaterEqual(jacket["exact_count"], 1)

    def test_zero_exact_summary_lists_fail_stage(self):
        weak = {
            "items": [
                {
                    "garment": {"id": "tee-1", "search_query": "white tee"},
                    "matches": [{"match_type": "similar", "url": "https://s.example/t", "visual_score": 0.5}],
                }
            ]
        }
        rows = [score_case({"id": "weak", "expect_empty": False}, [weak, weak, weak])]
        summary = summarize(rows)
        self.assertTrue(summary["zero_exact"])
        self.assertEqual(summary["fail_stages"], ["judge"])


if __name__ == "__main__":
    unittest.main()
