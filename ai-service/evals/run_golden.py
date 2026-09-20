"""Run the matching golden set (scorer fixtures, or live /api/identify)."""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
AI_SERVICE = ROOT.parent
sys.path.insert(0, str(AI_SERVICE))

from evals.golden.recorded import recorded_runs  # noqa: E402
from evals.metrics import score_case, summarize  # noqa: E402

MANIFEST = ROOT / "golden" / "manifest.json"
IMAGES = ROOT / "golden" / "images"
LIVE_RUNS = 3


def load_manifest() -> list[dict]:
    payload = json.loads(MANIFEST.read_text())
    return list(payload.get("cases") or [])


def evaluate(recorded: dict[str, list[dict]] | None = None) -> dict:
    cases = load_manifest()
    runs_by_id = recorded if recorded is not None else recorded_runs()
    rows = []
    for case in cases:
        case_id = str(case.get("id") or "")
        runs = runs_by_id.get(case_id) or []
        rows.append(score_case(case, runs))
    summary = summarize(rows)
    return {"summary": summary, "rows": rows}


def _case_image(case_id: str) -> Path | None:
    for suffix in (".jpg", ".jpeg", ".png", ".webp"):
        path = IMAGES / f"{case_id}{suffix}"
        if path.is_file():
            return path
    return None


def _identify_once(base_url: str, image: Path, timeout_s: float = 210.0) -> dict:
    import requests

    with image.open("rb") as handle:
        response = requests.post(
            f"{base_url.rstrip('/')}/api/identify",
            files={"image": (image.name, handle, "image/jpeg")},
            data={"origin": "app"},
            timeout=30,
        )
    response.raise_for_status()
    job_id = response.json().get("job_id")
    if not job_id:
        raise RuntimeError(f"identify did not return job_id: {response.text[:200]}")
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        job = requests.get(f"{base_url.rstrip('/')}/jobs/{job_id}", timeout=10)
        job.raise_for_status()
        payload = job.json()
        status = payload.get("status")
        if status == "done":
            return payload
        if status == "error":
            raise RuntimeError(payload.get("error") or f"job {job_id} failed")
        time.sleep(1.5)
    raise TimeoutError(f"job {job_id} did not finish in {int(timeout_s)}s")


def live_runs(base_url: str, runs: int = LIVE_RUNS) -> dict[str, list[dict]]:
    cases = load_manifest()
    missing = [str(case.get("id") or "") for case in cases if not _case_image(str(case.get("id") or ""))]
    if missing:
        raise FileNotFoundError(
            "Live eval needs one image per case in evals/golden/images/ "
            f"(missing: {', '.join(missing)}). Name files {{case_id}}.jpg"
        )
    out: dict[str, list[dict]] = {}
    for case in cases:
        case_id = str(case.get("id") or "")
        image = _case_image(case_id)
        assert image is not None
        out[case_id] = [_identify_once(base_url, image) for _ in range(runs)]
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description="Fit Stealer matching golden-set eval")
    parser.add_argument(
        "--live",
        action="store_true",
        help="POST evals/golden/images/{case_id}.jpg to Express three times per case.",
    )
    parser.add_argument(
        "--base-url",
        default="http://127.0.0.1:4000",
        help="Express origin for --live (default http://127.0.0.1:4000)",
    )
    args = parser.parse_args()
    if args.live:
        try:
            report = evaluate(live_runs(args.base_url))
        except FileNotFoundError as exc:
            print(str(exc), file=sys.stderr)
            return 2
        except Exception as exc:
            print(f"Live golden eval failed: {exc}", file=sys.stderr)
            return 2
        print(json.dumps(report, indent=2))
        summary = report["summary"]
        if summary["stable_cases"] != summary["cases"]:
            print("FAIL: live runs were not stable (Jaccard < 1 or top URL drifted)", file=sys.stderr)
            return 1
        print(
            f"LIVE {summary['stable_cases']}/{summary['cases']} stable, exact_rate={summary['exact_rate']}",
            file=sys.stderr,
        )
        return 0

    report = evaluate()
    print(json.dumps(report, indent=2))
    summary = report["summary"]
    print(
        "NOTE: recorded fixtures only test the scorer. Use --live with "
        "evals/golden/images for matching accuracy.",
        file=sys.stderr,
    )
    if summary["stable_cases"] != summary["cases"]:
        print("FAIL: scorer fixtures drifted", file=sys.stderr)
        return 1
    print(
        f"OK scorer {summary['stable_cases']}/{summary['cases']} stable",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
