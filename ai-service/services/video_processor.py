"""
Video Processor — Stage 3 Ingest

Two-tier keyframe extraction pipeline:
  Tier 1 (local, fast): ffmpeg frame extraction → PIL sharpness scoring → top candidates
  Tier 2 (VLM):         Baseten selects best outfit frames + identifies garments in one call

Architecture contract (§4 Stage 3, §7.2):
  POST /tools/ingest accepts { type: "video" } multipart
  Returns: { garments: Garment[], outfit_summary: str, frame_count: int }
"""

from __future__ import annotations

import json
import logging
import math
import os
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path
from typing import TypedDict

import numpy as np
from PIL import Image, ImageFilter

logger = logging.getLogger("fit_stealer.ingest")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
MAX_DURATION_S = 15          # Reject videos longer than this
SAMPLE_FPS = 1               # Extract 1 frame per second
MAX_CANDIDATES = 8           # Send at most this many to VLM
MIN_SHARPNESS = 50.0         # Drop frames blurrier than this
MIN_MEAN_PIXEL = 15          # Drop near-black frames
MAX_MEAN_PIXEL = 245         # Drop near-white frames
TEMPORAL_BUCKET_S = 1.5      # Keep only the sharpest frame per bucket
FRAME_LONG_EDGE = 768        # Downscale candidates for fast transfer
FFMPEG_BIN = os.getenv("FFMPEG_BIN", "ffmpeg")
FFPROBE_BIN = os.getenv("FFPROBE_BIN", "ffprobe")

ALLOWED_VIDEO_EXTENSIONS = {".mp4", ".mov", ".webm", ".avi", ".mkv", ".m4v"}
MAX_VIDEO_SIZE_BYTES = 50 * 1024 * 1024  # 50 MB


# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------
class CandidateFrame(TypedDict):
    path: str
    timestamp: float
    sharpness: float


class VideoIngestResult(TypedDict):
    garments: list[dict]
    outfit_summary: str
    frame_count: int
    selected_frames: int
    candidate_dir: str


# ---------------------------------------------------------------------------
# ffprobe helpers
# ---------------------------------------------------------------------------
def probe_video(video_path: str) -> dict:
    """Get video metadata using ffprobe. Returns {duration, fps, width, height}."""
    cmd = [
        FFPROBE_BIN,
        "-v", "quiet",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        video_path,
    ]
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=10,
        )
    except FileNotFoundError:
        raise RuntimeError(
            f"ffprobe not found at '{FFPROBE_BIN}'. "
            "Install ffmpeg or set FFPROBE_BIN env var."
        )

    if result.returncode != 0:
        raise ValueError(
            f"ffprobe failed (code {result.returncode}): {result.stderr.strip()}"
        )

    data = json.loads(result.stdout)

    # Find the video stream
    video_stream = None
    for stream in data.get("streams", []):
        if stream.get("codec_type") == "video":
            video_stream = stream
            break

    if not video_stream:
        raise ValueError("No video stream found in file")

    # Parse duration from format or stream
    duration = float(
        data.get("format", {}).get("duration")
        or video_stream.get("duration")
        or 0
    )

    # Parse fps from r_frame_rate (e.g. "30/1" or "30000/1001")
    fps_str = video_stream.get("r_frame_rate", "30/1")
    if "/" in fps_str:
        num, den = fps_str.split("/")
        fps = float(num) / float(den) if float(den) != 0 else 30.0
    else:
        fps = float(fps_str) or 30.0

    return {
        "duration": duration,
        "fps": fps,
        "width": int(video_stream.get("width", 0)),
        "height": int(video_stream.get("height", 0)),
    }


def validate_video(video_path: str) -> dict:
    """Validate video file and return metadata. Raises on invalid."""
    path = Path(video_path)

    if not path.exists():
        raise FileNotFoundError(f"Video file not found: {video_path}")

    if path.suffix.lower() not in ALLOWED_VIDEO_EXTENSIONS:
        raise ValueError(
            f"Unsupported video format '{path.suffix}'. "
            f"Allowed: {', '.join(sorted(ALLOWED_VIDEO_EXTENSIONS))}"
        )

    file_size = path.stat().st_size
    if file_size > MAX_VIDEO_SIZE_BYTES:
        raise ValueError(
            f"Video too large ({file_size / 1024 / 1024:.1f} MB). "
            f"Maximum: {MAX_VIDEO_SIZE_BYTES / 1024 / 1024:.0f} MB."
        )

    meta = probe_video(video_path)

    if meta["duration"] > MAX_DURATION_S:
        raise ValueError(
            f"Video too long ({meta['duration']:.1f}s). "
            f"Maximum: {MAX_DURATION_S}s. Trim the clip or upload a screenshot."
        )

    if meta["duration"] < 0.5:
        raise ValueError(
            "Video too short (< 0.5s). Upload a longer clip or a screenshot."
        )

    logger.info(
        "ingest — video validated: %.1fs, %dx%d, %.1f fps, %.1f MB",
        meta["duration"], meta["width"], meta["height"],
        meta["fps"], file_size / 1024 / 1024,
    )
    return meta


# ---------------------------------------------------------------------------
# Tier 1: Frame extraction + sharpness scoring
# ---------------------------------------------------------------------------
def _extract_raw_frames(video_path: str, output_dir: str, fps: int = SAMPLE_FPS) -> list[str]:
    """Use ffmpeg to extract frames at the given fps. Returns sorted list of paths."""
    out_pattern = os.path.join(output_dir, "frame_%04d.jpg")
    cmd = [
        FFMPEG_BIN,
        "-i", video_path,
        "-vf", f"fps={fps}",
        "-q:v", "2",           # high-quality JPEG
        "-y",                   # overwrite
        out_pattern,
    ]
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=30,
        )
    except FileNotFoundError:
        raise RuntimeError(
            f"ffmpeg not found at '{FFMPEG_BIN}'. "
            "Install ffmpeg or set FFMPEG_BIN env var."
        )

    if result.returncode != 0:
        raise RuntimeError(
            f"ffmpeg frame extraction failed (code {result.returncode}): "
            f"{result.stderr.strip()[-500:]}"
        )

    frames = sorted(
        str(p) for p in Path(output_dir).glob("frame_*.jpg")
    )
    logger.info("ingest — ffmpeg extracted %d raw frames at %d fps", len(frames), fps)
    return frames


def _compute_sharpness(image: Image.Image) -> float:
    """Compute sharpness using Laplacian variance on a grayscale image.

    Higher values = sharper. Blurry/motion-blurred frames score low.
    Uses PIL's built-in FIND_EDGES kernel as a Laplacian approximation.
    """
    gray = image.convert("L")
    # Apply edge-detection filter (approximates Laplacian)
    edges = gray.filter(ImageFilter.FIND_EDGES)
    # Convert to numpy for variance computation
    arr = np.array(edges, dtype=np.float64)
    return float(arr.var())


def _compute_mean_brightness(image: Image.Image) -> float:
    """Compute mean pixel brightness of grayscale version."""
    gray = image.convert("L")
    arr = np.array(gray, dtype=np.float64)
    return float(arr.mean())


def _downscale_frame(image: Image.Image, max_edge: int = FRAME_LONG_EDGE) -> Image.Image:
    """Downscale so longest edge is max_edge pixels. Returns a new image."""
    w, h = image.size
    longest = max(w, h)
    if longest <= max_edge:
        return image.copy()
    scale = max_edge / longest
    new_w = max(1, int(w * scale))
    new_h = max(1, int(h * scale))
    return image.resize((new_w, new_h), Image.Resampling.LANCZOS)


def extract_candidate_frames(
    video_path: str,
    max_candidates: int = MAX_CANDIDATES,
    work_dir: str | None = None,
) -> tuple[list[CandidateFrame], str]:
    """
    Tier 1: Extract and score candidate frames from a video.

    1. ffmpeg extracts 1 frame/sec as JPEGs
    2. Score each for sharpness (Laplacian variance)
    3. Drop dark/white/blurry frames
    4. Temporal bucketing: keep sharpest per 1.5s window
    5. Return top N candidates sorted by timestamp

    Args:
        video_path: Path to the input video file.
        max_candidates: Maximum frames to return.
        work_dir: Optional directory for temp files. Created if None.

    Returns:
        (candidates, work_dir) where candidates is a list of CandidateFrame dicts
        and work_dir is the temp directory (caller should clean up).
    """
    # Create working directories
    if work_dir is None:
        work_dir = tempfile.mkdtemp(prefix="fit-stealer-video-")

    raw_dir = os.path.join(work_dir, "raw")
    candidate_dir = os.path.join(work_dir, "candidates")
    os.makedirs(raw_dir, exist_ok=True)
    os.makedirs(candidate_dir, exist_ok=True)

    # Step 1: Extract raw frames with ffmpeg
    raw_paths = _extract_raw_frames(video_path, raw_dir, fps=SAMPLE_FPS)

    if not raw_paths:
        logger.warning("ingest — ffmpeg produced no frames")
        return [], work_dir

    # Step 2: Score each frame
    scored: list[dict] = []
    for i, frame_path in enumerate(raw_paths):
        try:
            img = Image.open(frame_path).convert("RGB")
        except Exception as exc:
            logger.debug("ingest — skipping unreadable frame %d: %s", i, exc)
            continue

        sharpness = _compute_sharpness(img)
        brightness = _compute_mean_brightness(img)
        timestamp = float(i) / SAMPLE_FPS  # approximate timestamp

        scored.append({
            "index": i,
            "path": frame_path,
            "image": img,
            "sharpness": sharpness,
            "brightness": brightness,
            "timestamp": timestamp,
        })

    logger.info(
        "ingest — scored %d frames, sharpness range [%.0f, %.0f]",
        len(scored),
        min(s["sharpness"] for s in scored) if scored else 0,
        max(s["sharpness"] for s in scored) if scored else 0,
    )

    # Step 3: Filter out bad frames
    filtered = [
        s for s in scored
        if s["sharpness"] >= MIN_SHARPNESS
        and s["brightness"] >= MIN_MEAN_PIXEL
        and s["brightness"] <= MAX_MEAN_PIXEL
    ]
    dropped = len(scored) - len(filtered)
    if dropped:
        logger.info(
            "ingest — dropped %d frames (blurry/dark/white), %d remain",
            dropped, len(filtered),
        )

    if not filtered:
        # Fallback: if all frames are "bad", take the best from the originals
        logger.warning("ingest — all frames filtered out, falling back to top %d by sharpness", max_candidates)
        filtered = sorted(scored, key=lambda s: s["sharpness"], reverse=True)[:max_candidates]

    # Step 4: Temporal bucketing — keep sharpest per bucket
    num_buckets = max(1, math.ceil(
        (max(s["timestamp"] for s in filtered) + 0.01) / TEMPORAL_BUCKET_S
    ))
    buckets: dict[int, dict] = {}
    for s in filtered:
        bucket_idx = int(s["timestamp"] / TEMPORAL_BUCKET_S)
        if bucket_idx not in buckets or s["sharpness"] > buckets[bucket_idx]["sharpness"]:
            buckets[bucket_idx] = s

    bucketed = sorted(buckets.values(), key=lambda s: s["timestamp"])
    logger.info(
        "ingest — %d temporal buckets (%.1fs each), %d winners",
        num_buckets, TEMPORAL_BUCKET_S, len(bucketed),
    )

    # Step 5: Take top N by sharpness, then re-sort by timestamp
    if len(bucketed) > max_candidates:
        bucketed = sorted(bucketed, key=lambda s: s["sharpness"], reverse=True)[:max_candidates]
        bucketed = sorted(bucketed, key=lambda s: s["timestamp"])

    # Step 6: Downscale and save candidates
    candidates: list[CandidateFrame] = []
    for s in bucketed:
        img_small = _downscale_frame(s["image"])
        out_name = f"candidate_{s['index']:04d}.jpg"
        out_path = os.path.join(candidate_dir, out_name)
        img_small.save(out_path, "JPEG", quality=80)
        candidates.append(CandidateFrame(
            path=out_path,
            timestamp=s["timestamp"],
            sharpness=s["sharpness"],
        ))

    logger.info(
        "ingest — %d candidate frames ready for VLM (timestamps: %s)",
        len(candidates),
        ", ".join(f"{c['timestamp']:.1f}s" for c in candidates),
    )

    return candidates, work_dir


# ---------------------------------------------------------------------------
# Tier 2: VLM selection + garment identification (single call)
# ---------------------------------------------------------------------------
def select_and_identify_from_video(video_path: str) -> VideoIngestResult:
    """
    Full Stage 3 ingest pipeline: video → candidate frames → VLM → Garment[].

    Orchestrates:
      1. validate_video() — check duration, format, size
      2. extract_candidate_frames() — Tier 1 local heuristics
      3. analyze_frames_with_vlm() — Tier 2 VLM (selection + identification)

    Returns VideoIngestResult with garments, summary, and frame counts.
    """
    from services.baseten_vlm import analyze_frames_with_vlm

    # Step 1: Validate
    meta = validate_video(video_path)
    logger.info(
        "ingest — processing %.1fs video (%dx%d)",
        meta["duration"], meta["width"], meta["height"],
    )

    # Step 2: Extract candidates (Tier 1)
    candidates, work_dir = extract_candidate_frames(video_path)

    if not candidates:
        logger.warning("ingest — no usable frames extracted from video")
        return VideoIngestResult(
            garments=[],
            outfit_summary="Could not extract any clear frames from the video.",
            frame_count=0,
            selected_frames=0,
            candidate_dir=work_dir,
        )

    # Step 3: Send to VLM with frame metadata (Tier 2)
    image_paths = [c["path"] for c in candidates]
    frame_metadata = [
        {"index": i, "timestamp": c["timestamp"], "sharpness": c["sharpness"]}
        for i, c in enumerate(candidates)
    ]

    try:
        result = analyze_frames_with_vlm(
            image_paths,
            frame_metadata=frame_metadata,
        )
    except Exception:
        logger.exception("ingest — VLM analysis failed")
        raise

    garments = result.get("garments", [])
    outfit_summary = result.get("outfit_summary", "")

    logger.info(
        "ingest — VLM returned %d garments from %d candidate frames",
        len(garments), len(candidates),
    )

    return VideoIngestResult(
        garments=garments,
        outfit_summary=outfit_summary,
        frame_count=len(candidates),
        selected_frames=len(candidates),
        candidate_dir=work_dir,
    )


# ---------------------------------------------------------------------------
# Cleanup helper
# ---------------------------------------------------------------------------
def cleanup_work_dir(work_dir: str) -> None:
    """Remove the temporary working directory created during video processing."""
    try:
        shutil.rmtree(work_dir, ignore_errors=True)
    except Exception:
        logger.debug("ingest — failed to clean up %s", work_dir)


# ---------------------------------------------------------------------------
# Standalone test
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import sys

    logging.basicConfig(level=logging.INFO, format="%(message)s")

    if len(sys.argv) < 2:
        print("Usage: python video_processor.py <video_path>")
        print("  Extracts candidate frames and runs VLM analysis.")
        sys.exit(1)

    video_file = sys.argv[1]
    print(f"[INFO] Processing video: {video_file}")

    # Tier 1 only (no VLM call) if --frames-only flag
    if "--frames-only" in sys.argv:
        meta = validate_video(video_file)
        print(f"[OK] Video: {meta['duration']:.1f}s, {meta['width']}x{meta['height']}, {meta['fps']:.1f} fps")
        candidates, work_dir = extract_candidate_frames(video_file)
        print(f"\n[OK] {len(candidates)} candidate frames extracted to: {work_dir}")
        for c in candidates:
            print(f"  [{c['timestamp']:.1f}s] sharpness={c['sharpness']:.0f} → {c['path']}")
        print(f"\nClean up with: rm -rf {work_dir}")
    else:
        result = select_and_identify_from_video(video_file)
        print(f"\n[OK] {len(result['garments'])} garments from {result['frame_count']} frames")
        for i, g in enumerate(result["garments"]):
            src = g.get("source_frame_index", "?")
            print(f"  [{i}] {g.get('category', '?')} — \"{g.get('search_query', '')}\" (frame {src})")
        print(f"\n[SUMMARY] {result['outfit_summary']}")
        cleanup_work_dir(result["candidate_dir"])
