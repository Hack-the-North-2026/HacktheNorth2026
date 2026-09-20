"""
Video Processor — Stage 3 Ingest

Two-tier keyframe extraction pipeline:
  Tier 1 (local, fast): ffmpeg sampling → downscale → sharpness/brightness
                        vetting → evenly-spread coverage-window selection.
                        This tier decides *which* frames are clear enough
                        and where they come from in the clip.
  Tier 2 (VLM):         Baseten identifies garments across the already-vetted
                        frames and merges duplicates seen in more than one.

Architecture contract (§4 Stage 3, §7.2):
  POST /tools/ingest accepts { type: "video" } multipart
  Returns: { garments: Garment[], outfit_summary: str, frame_count: int }
"""

from __future__ import annotations

import base64
import json
import logging
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
SAMPLE_FPS = 4               # Extract 4 frames/sec — dense enough that each
                              # coverage window (see below) has real choices,
                              # not just whatever one frame landed on the second.
MAX_CANDIDATES = 5           # Send at most this many to the VLM (§4 Stage 3: 3-5 keyframes)
MIN_SHARPNESS = 50.0         # Drop frames blurrier than this — the actual
                              # "is this clear enough to search with" gate.
MIN_MEAN_PIXEL = 15          # Drop near-black frames
MAX_MEAN_PIXEL = 245         # Drop near-white frames
FRAME_LONG_EDGE = 768        # Downscale candidates for fast transfer
FFMPEG_BIN = os.getenv("FFMPEG_BIN", "ffmpeg")
FFPROBE_BIN = os.getenv("FFPROBE_BIN", "ffprobe")

ALLOWED_VIDEO_EXTENSIONS = {".mp4", ".mov", ".webm", ".mkv", ".m4v"}
MAX_VIDEO_SIZE_BYTES = 50 * 1024 * 1024  # 50 MB
_FFMPEG_OK: bool | None = None


def _bin_available(binary: str) -> bool:
    try:
        result = subprocess.run(
            [binary, "-version"],
            capture_output=True,
            timeout=5,
        )
        return result.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


def ffmpeg_available() -> bool:
    """True when ffmpeg and ffprobe are on PATH (or FFMPEG_BIN / FFPROBE_BIN)."""
    global _FFMPEG_OK
    if _FFMPEG_OK is None:
        _FFMPEG_OK = _bin_available(FFMPEG_BIN) and _bin_available(FFPROBE_BIN)
    return _FFMPEG_OK


# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------
class CandidateFrame(TypedDict):
    path: str
    timestamp: float
    sharpness: float


class VideoIngestResult(TypedDict, total=False):
    garments: list[dict]
    outfit_summary: str
    frame_count: int
    selected_frames: int
    candidate_dir: str
    keyframes: list[str]
    image_paths: list[str]
    frames: list[dict]
    duration: float


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
    # Scale on extract so 8K clips never write full-res JPEGs to disk.
    scale = (
        f"scale='if(gte(iw,ih),{FRAME_LONG_EDGE},-2)':"
        f"'if(gt(ih,iw),{FRAME_LONG_EDGE},-2)'"
    )
    cmd = [
        FFMPEG_BIN,
        "-nostdin",
        "-hide_banner",
        "-loglevel", "error",
        "-i", video_path,
        "-vf", f"fps={fps},{scale}",
        "-q:v", "4",
        "-y",
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
    duration_s: float | None = None,
) -> tuple[list[CandidateFrame], str]:
    """
    Tier 1: Extract, vet, and select candidate frames from a video.

    1. ffmpeg samples at SAMPLE_FPS as JPEGs
    2. Downscale each frame first (cheap), then score sharpness + brightness
       on the downscaled copy — this is both faster and gives thresholds
       that mean the same thing regardless of the source video's resolution.
    3. Vet: drop any frame that isn't clear enough to search with (too
       blurry, too dark, too bright). This is a real gate, not a suggestion —
       if nothing in the clip passes, we return no candidates rather than
       forwarding a frame we already know is bad to the (expensive) VLM call.
    4. Coverage windows: split the clip into `max_candidates` equal time
       windows and keep only the sharpest *qualifying* frame per window, so
       picks are spread across the whole clip instead of clustering wherever
       happens to be globally sharpest. A window with no qualifying frame is
       simply skipped (fewer, honest candidates beat a padded bad one).

    Args:
        video_path: Path to the input video file.
        max_candidates: Maximum frames to return (also the number of
            coverage windows the clip is split into).
        work_dir: Optional directory for temp files. Created if None.
        duration_s: Known video duration in seconds (e.g. from ffprobe).
            Falls back to the last sampled timestamp if not given.

    Returns:
        (candidates, work_dir) where candidates is a list of CandidateFrame dicts
        and work_dir is the temp directory (caller should clean up). An empty
        candidate list means no frame in the clip was clear enough to use.
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

    # Step 2: Downscale first, then score — scoring a 768px frame instead of
    # a full-res one is the single biggest local speedup, and it makes
    # MIN_SHARPNESS mean the same thing for a 4K phone clip and a 480p one.
    scored: list[dict] = []
    for i, frame_path in enumerate(raw_paths):
        try:
            with Image.open(frame_path) as opened:
                img = opened.convert("RGB")
                img_small = _downscale_frame(img)
                if img_small is not img:
                    img.close()
                sharpness = _compute_sharpness(img_small)
                brightness = _compute_mean_brightness(img_small)
                img_small.close()
        except Exception as exc:
            logger.debug("ingest — skipping unreadable frame %d: %s", i, exc)
            continue

        timestamp = float(i) / SAMPLE_FPS  # approximate timestamp
        scored.append({
            "index": i,
            "path": frame_path,
            "sharpness": sharpness,
            "brightness": brightness,
            "timestamp": timestamp,
        })

    if not scored:
        return [], work_dir

    logger.info(
        "ingest — scored %d frames, sharpness range [%.0f, %.0f]",
        len(scored),
        min(s["sharpness"] for s in scored),
        max(s["sharpness"] for s in scored),
    )

    # Step 3: Vet — drop anything not clear enough to search with. No
    # fallback: if every sampled frame fails, the clip genuinely doesn't
    # have a usable view of the outfit, and the caller should say so
    # honestly instead of the VLM being handed junk.
    filtered = [
        s for s in scored
        if s["sharpness"] >= MIN_SHARPNESS
        and MIN_MEAN_PIXEL <= s["brightness"] <= MAX_MEAN_PIXEL
    ]
    dropped = len(scored) - len(filtered)
    if dropped:
        logger.info(
            "ingest — dropped %d frames (blurry/dark/bright), %d remain",
            dropped, len(filtered),
        )

    if not filtered:
        logger.warning(
            "ingest — no frame in the clip was clear enough to use (%d sampled, 0 passed)",
            len(scored),
        )
        return [], work_dir

    # Step 4: Coverage windows — the sharpest qualifying frame per window,
    # spread evenly across the clip's actual duration.
    clip_duration = duration_s if duration_s is not None else scored[-1]["timestamp"]
    window_s = max(clip_duration, 0.01) / max_candidates
    winners: dict[int, dict] = {}
    for s in filtered:
        window_idx = min(int(s["timestamp"] / window_s), max_candidates - 1)
        if window_idx not in winners or s["sharpness"] > winners[window_idx]["sharpness"]:
            winners[window_idx] = s

    selected = sorted(winners.values(), key=lambda s: s["timestamp"])
    logger.info(
        "ingest — %d coverage windows (%.1fs each), %d winners",
        max_candidates, window_s, len(selected),
    )

    # Step 5: Copy already-scaled winners into the candidate dir.
    candidates: list[CandidateFrame] = []
    for s in selected:
        out_name = f"candidate_{s['index']:04d}.jpg"
        out_path = os.path.join(candidate_dir, out_name)
        src = Path(s["path"])
        if src.is_file():
            Path(out_path).write_bytes(src.read_bytes())
        else:
            continue
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


# Frames beyond this go through the cheap visibility-selection call before
# ever reaching the expensive high-detail identification call.
KEEP_FOR_IDENTIFICATION = 3


def keyframes_from_paths(image_paths: list[str]) -> list[str]:
    """Encode existing JPEGs as data-URLs for the scan UI."""
    keyframes_data: list[str] = []
    for p in image_paths:
        if not p or not os.path.exists(p):
            continue
        try:
            with open(p, "rb") as f:
                b64 = base64.b64encode(f.read()).decode("utf-8")
                keyframes_data.append(f"data:image/jpeg;base64,{b64}")
        except OSError:
            continue
    return keyframes_data


def persist_selected_frames(
    frames: list[dict],
    dest_dir: str,
    prefix: str,
) -> list[dict]:
    """Copy kept frames into fit-stealer-chips so they survive work_dir cleanup."""
    dest = Path(dest_dir)
    dest.mkdir(parents=True, exist_ok=True)
    persisted: list[dict] = []
    for frame in frames:
        src = Path(str(frame.get("path") or ""))
        if not src.is_file():
            continue
        index = int(frame.get("index") or 0)
        dest_path = dest / f"{prefix}_frame_{index:04d}.jpg"
        dest_path.write_bytes(src.read_bytes())
        persisted.append({
            "path": str(dest_path.resolve()),
            "timestamp": float(frame.get("timestamp") or 0),
            "sharpness": float(frame.get("sharpness") or 0),
            "index": index,
        })
    return persisted


def ingest_video_frames(video_path: str) -> VideoIngestResult:
    """
    Stage V1 ingest — ffmpeg + sharpness windows only. No VLM.

    Visibility pick belongs in See so the 30s ingest budget cannot include
    a Baseten call. Express publishes these frames, then /tools/see keeps ≤3.
    """
    meta = validate_video(video_path)
    duration_s = float(meta["duration"])
    logger.info(
        "ingest — processing %.1fs video (%dx%d)",
        duration_s, meta["width"], meta["height"],
    )

    candidates, work_dir = extract_candidate_frames(video_path, duration_s=duration_s)

    if not candidates:
        logger.warning("ingest — no frame in the video was clear enough to search with")
        return VideoIngestResult(
            garments=[],
            outfit_summary="Couldn't find a clear enough view of the outfit in this clip.",
            frame_count=0,
            selected_frames=0,
            candidate_dir=work_dir,
            image_paths=[],
            frames=[],
            keyframes=[],
            duration=duration_s,
        )

    frames = [
        {
            "path": c["path"],
            "timestamp": c["timestamp"],
            "sharpness": c["sharpness"],
            "index": i,
        }
        for i, c in enumerate(candidates)
    ]
    image_paths = [frame["path"] for frame in frames]
    logger.info(
        "ingest — %d coverage-window frames ready for See (visibility pick happens there)",
        len(frames),
    )

    return VideoIngestResult(
        garments=[],
        outfit_summary="",
        frame_count=len(candidates),
        selected_frames=len(frames),
        candidate_dir=work_dir,
        image_paths=image_paths,
        frames=frames,
        keyframes=keyframes_from_paths(image_paths),
        duration=duration_s,
    )


# ---------------------------------------------------------------------------
# Combined ingest + See (convenience / identify-video fallback)
# ---------------------------------------------------------------------------
def select_and_identify_from_video(video_path: str) -> VideoIngestResult:
    """
    Full Stage 3 convenience: ingest frames, then VLM garments.

    Express V1 calls ingest and See separately so the job can show
    ingesting → seeing. This helper stays for /api/identify-video.
    """
    from services.baseten_vlm import analyze_frames_with_vlm

    ingested = ingest_video_frames(video_path)
    image_paths = ingested.get("image_paths") or []
    frames = ingested.get("frames") or []
    if not image_paths:
        return ingested

    frame_metadata = [
        {
            "index": frame.get("index", i),
            "timestamp": frame.get("timestamp", 0),
            "sharpness": frame.get("sharpness", 0),
        }
        for i, frame in enumerate(frames)
    ]

    try:
        result = analyze_frames_with_vlm(
            image_paths,
            frame_metadata=frame_metadata,
        )
    except Exception:
        logger.exception("see — VLM analysis failed")
        raise

    garments = result.get("garments", [])
    outfit_summary = result.get("outfit_summary", "")
    logger.info(
        "see — VLM returned %d garments from %d selected frames",
        len(garments), len(image_paths),
    )

    return VideoIngestResult(
        garments=garments,
        outfit_summary=outfit_summary,
        frame_count=ingested.get("frame_count", 0),
        selected_frames=ingested.get("selected_frames", len(image_paths)),
        candidate_dir=ingested.get("candidate_dir", ""),
        image_paths=image_paths,
        frames=frames,
        keyframes=ingested.get("keyframes") or keyframes_from_paths(image_paths),
        duration=ingested.get("duration"),
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
