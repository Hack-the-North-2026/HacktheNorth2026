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
from evals.golden.videos.recorded import recorded_video_runs  # noqa: E402
from evals.metrics import score_case, summarize  # noqa: E402

MANIFEST = ROOT / "golden" / "manifest.json"
VIDEO_MANIFEST = ROOT / "golden" / "videos" / "manifest.json"
IMAGES = ROOT / "golden" / "images"
VIDEOS = ROOT / "golden" / "videos"
LIVE_RUNS = 3


def _load_json_cases(path: Path, default_media: str) -> list[dict]:
    if not path.is_file():
        return []
    payload = json.loads(path.read_text())
    cases = []
    for case in payload.get("cases") or []:
        row = dict(case)
        row.setdefault("media", default_media)
        cases.append(row)
    return cases


def load_manifest(media: str | None = None) -> list[dict]:
    cases = _load_json_cases(MANIFEST, "image") + _load_json_cases(VIDEO_MANIFEST, "video")
    if media:
        return [case for case in cases if case.get("media", "image") == media]
    return cases


def all_recorded_runs() -> dict[str, list[dict]]:
    merged = dict(recorded_runs())
    merged.update(recorded_video_runs())
    return merged


def evaluate(recorded: dict[str, list[dict]] | None = None, media: str | None = None) -> dict:
    cases = load_manifest(media)
    runs_by_id = recorded if recorded is not None else all_recorded_runs()
    rows = []
    for case in cases:
        case_id = str(case.get("id") or "")
        if recorded is not None and case_id not in runs_by_id:
            continue
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


def _case_video(case_id: str) -> Path | None:
    for suffix in (".mp4", ".mov", ".webm", ".m4v"):
        path = VIDEOS / f"{case_id}{suffix}"
        if path.is_file():
            return path
    return None


def _identify_once(base_url: str, media: Path, media_type: str = "image", timeout_s: float = 270.0) -> dict:
    import requests

    field = "video" if media_type == "video" else "image"
    suffix = media.suffix.lower()
    if media_type == "video":
        content = "video/quicktime" if suffix == ".mov" else "video/mp4"
    else:
        content = "image/jpeg"
    with media.open("rb") as handle:
        response = requests.post(
            f"{base_url.rstrip('/')}/api/identify",
            files={field: (media.name, handle, content)},
            data={"origin": "app", "type": media_type},
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


def live_runs(base_url: str, runs: int = LIVE_RUNS, media: str | None = "image") -> dict[str, list[dict]]:
    cases = load_manifest(media)
    missing = []
    for case in cases:
        case_id = str(case.get("id") or "")
        kind = case.get("media", "image")
        found = _case_video(case_id) if kind == "video" else _case_image(case_id)
        if not found:
            missing.append(case_id)
    present = [case for case in cases if str(case.get("id") or "") not in missing]
    if not present:
        folder = "evals/golden/videos/" if media == "video" else "evals/golden/images/"
        raise FileNotFoundError(
            f"Live eval needs at least one file in {folder} "
            f"(missing: {', '.join(missing)}). Name files {{case_id}}.jpg/.mp4/.mov"
        )
    if missing:
        print(
            f"NOTE: skipping {len(missing)} cases without media: {', '.join(missing)}",
            file=sys.stderr,
        )
    out: dict[str, list[dict]] = {}
    for case in present:
        case_id = str(case.get("id") or "")
        kind = case.get("media", "image")
        path = _case_video(case_id) if kind == "video" else _case_image(case_id)
        assert path is not None
        print(f"live — {case_id} × {runs} from {path.name}", file=sys.stderr)
        out[case_id] = [_identify_once(base_url, path, kind) for _ in range(runs)]
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description="Fit Stealer matching golden-set eval")
    parser.add_argument(
        "--live",
        action="store_true",
        help="POST golden stills (or --videos clips) to Express three times per case.",
    )
    parser.add_argument(
        "--videos",
        action="store_true",
        help="Score the video golden set (recorded fixtures, or live clips with --live).",
    )
    parser.add_argument(
        "--base-url",
        default="http://127.0.0.1:4000",
        help="Express origin for --live (default http://127.0.0.1:4000)",
    )
    args = parser.parse_args()
    media = "video" if args.videos else "image"
    if args.live:
        try:
            live = live_runs(args.base_url, media=media)
            report = evaluate(live, media=media)
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

    report = evaluate(media=media)
    print(json.dumps(report, indent=2))
    summary = report["summary"]
    print(
        "NOTE: recorded fixtures only test the scorer. Use --live with "
        "evals/golden/images, or --live --videos with evals/golden/videos.",
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
