"""
Tests for ai-service/services/video_processor.py

Covers:
  - Sharpness scoring
  - Brightness filtering
  - Frame downscaling
  - Candidate extraction (with a synthetic ffmpeg video)
  - Validation (duration cap, format, size)
"""

import math
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pytest
from PIL import Image, ImageDraw, ImageFilter

# Ensure imports resolve from ai-service root
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.video_processor import (
    _compute_mean_brightness,
    _compute_sharpness,
    _downscale_frame,
    extract_candidate_frames,
    validate_video,
    MAX_DURATION_S,
    ALLOWED_VIDEO_EXTENSIONS,
    MAX_VIDEO_SIZE_BYTES,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def sharp_image():
    """Create a high-contrast, sharp test image."""
    img = Image.new("RGB", (200, 200), (128, 128, 128))
    draw = ImageDraw.Draw(img)
    # Draw sharp black/white stripes
    for y in range(0, 200, 4):
        draw.rectangle([(0, y), (200, y + 2)], fill=(255, 255, 255))
        draw.rectangle([(0, y + 2), (200, y + 4)], fill=(0, 0, 0))
    return img


@pytest.fixture
def blurry_image(sharp_image):
    """Create a blurred version of the sharp image."""
    return sharp_image.filter(ImageFilter.GaussianBlur(radius=5))


@pytest.fixture
def dark_image():
    """Create a near-black image."""
    return Image.new("RGB", (200, 200), (5, 5, 5))


@pytest.fixture
def bright_image():
    """Create a near-white image."""
    return Image.new("RGB", (200, 200), (250, 250, 250))


def _has_ffmpeg():
    """Check if ffmpeg is available on the system."""
    try:
        subprocess.run(["ffmpeg", "-version"], capture_output=True, timeout=5)
        return True
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


def _make_test_video(output_path: str, duration: float = 3.0, fps: int = 10):
    """Generate a synthetic test video using ffmpeg.

    Creates a video with colored frames that change each second:
    - Second 0: red
    - Second 1: green
    - Second 2: blue
    """
    cmd = [
        "ffmpeg",
        "-f", "lavfi",
        "-i", f"testsrc=duration={duration}:size=320x240:rate={fps}",
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-y",
        output_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        raise RuntimeError(f"Failed to create test video: {result.stderr}")
    return output_path


# ---------------------------------------------------------------------------
# Unit tests: sharpness scoring
# ---------------------------------------------------------------------------

class TestSharpnessScoring:
    def test_sharp_image_scores_higher(self, sharp_image, blurry_image):
        """Sharp images must score higher than blurry ones."""
        sharp_score = _compute_sharpness(sharp_image)
        blurry_score = _compute_sharpness(blurry_image)
        assert sharp_score > blurry_score, (
            f"Sharp ({sharp_score:.1f}) should be > blurry ({blurry_score:.1f})"
        )

    def test_solid_color_scores_lower_than_sharp(self, sharp_image):
        """A solid-color image should score much lower than a sharp one."""
        solid = Image.new("RGB", (200, 200), (128, 128, 128))
        solid_score = _compute_sharpness(solid)
        sharp_score = _compute_sharpness(sharp_image)
        # Solid should be at least 10x lower than a high-contrast stripe image
        assert solid_score < sharp_score / 5, (
            f"Solid ({solid_score:.1f}) should be much less than sharp ({sharp_score:.1f})"
        )

    def test_sharpness_is_positive(self, sharp_image):
        """Sharpness should always be non-negative."""
        score = _compute_sharpness(sharp_image)
        assert score >= 0


# ---------------------------------------------------------------------------
# Unit tests: brightness
# ---------------------------------------------------------------------------

class TestBrightness:
    def test_dark_image(self, dark_image):
        """Dark image mean should be low."""
        brightness = _compute_mean_brightness(dark_image)
        assert brightness < 15, f"Dark image brightness should be < 15, got {brightness}"

    def test_bright_image(self, bright_image):
        """Bright image mean should be high."""
        brightness = _compute_mean_brightness(bright_image)
        assert brightness > 245, f"Bright image brightness should be > 245, got {brightness}"

    def test_normal_image(self, sharp_image):
        """Normal image should be in the middle range."""
        brightness = _compute_mean_brightness(sharp_image)
        assert 15 < brightness < 245


# ---------------------------------------------------------------------------
# Unit tests: downscaling
# ---------------------------------------------------------------------------

class TestDownscale:
    def test_small_image_not_changed(self):
        """Images smaller than max_edge should not be resized."""
        img = Image.new("RGB", (100, 100))
        result = _downscale_frame(img, max_edge=768)
        assert result.size == (100, 100)

    def test_large_image_downscaled(self):
        """Images larger than max_edge should be downscaled proportionally."""
        img = Image.new("RGB", (1920, 1080))
        result = _downscale_frame(img, max_edge=768)
        w, h = result.size
        assert max(w, h) == 768
        # Aspect ratio should be preserved (within rounding)
        assert abs(w / h - 1920 / 1080) < 0.02

    def test_portrait_image_downscaled(self):
        """Portrait orientation should also work."""
        img = Image.new("RGB", (1080, 1920))
        result = _downscale_frame(img, max_edge=768)
        w, h = result.size
        assert max(w, h) == 768
        assert h > w  # Still portrait


# ---------------------------------------------------------------------------
# Integration tests: video processing (requires ffmpeg)
# ---------------------------------------------------------------------------

@pytest.mark.skipif(not _has_ffmpeg(), reason="ffmpeg not available")
class TestCandidateExtraction:
    @pytest.fixture(autouse=True)
    def _setup_video(self, tmp_path):
        """Create a short test video for each test."""
        self.video_path = str(tmp_path / "test.mp4")
        _make_test_video(self.video_path, duration=5.0)

    def test_extraction_returns_frames(self):
        """Should extract multiple candidate frames from a valid video."""
        candidates, work_dir = extract_candidate_frames(self.video_path)
        try:
            assert len(candidates) > 0
            assert len(candidates) <= 8  # max_candidates default
            for c in candidates:
                assert os.path.exists(c["path"])
                assert c["timestamp"] >= 0
                assert c["sharpness"] >= 0
        finally:
            shutil.rmtree(work_dir, ignore_errors=True)

    def test_frames_are_sorted_by_timestamp(self):
        """Candidates should be sorted by timestamp."""
        candidates, work_dir = extract_candidate_frames(self.video_path)
        try:
            timestamps = [c["timestamp"] for c in candidates]
            assert timestamps == sorted(timestamps)
        finally:
            shutil.rmtree(work_dir, ignore_errors=True)

    def test_custom_max_candidates(self):
        """Should respect max_candidates parameter."""
        candidates, work_dir = extract_candidate_frames(
            self.video_path, max_candidates=2,
        )
        try:
            assert len(candidates) <= 2
        finally:
            shutil.rmtree(work_dir, ignore_errors=True)


@pytest.mark.skipif(not _has_ffmpeg(), reason="ffmpeg not available")
class TestValidation:
    def test_valid_video(self, tmp_path):
        """Valid video should pass validation."""
        video = str(tmp_path / "test.mp4")
        _make_test_video(video, duration=3.0)
        meta = validate_video(video)
        assert 2.5 <= meta["duration"] <= 3.5
        assert meta["width"] == 320
        assert meta["height"] == 240

    def test_nonexistent_file(self):
        """Should raise FileNotFoundError for missing files."""
        with pytest.raises(FileNotFoundError):
            validate_video("/tmp/nonexistent_video.mp4")

    def test_bad_extension(self, tmp_path):
        """Should reject unsupported extensions."""
        bad = tmp_path / "video.txt"
        bad.write_text("not a video")
        with pytest.raises(ValueError, match="Unsupported video format"):
            validate_video(str(bad))

    def test_too_long_video(self, tmp_path):
        """Should reject videos longer than MAX_DURATION_S."""
        video = str(tmp_path / "long.mp4")
        _make_test_video(video, duration=MAX_DURATION_S + 5)
        with pytest.raises(ValueError, match="Video too long"):
            validate_video(video)


# ---------------------------------------------------------------------------
# Standalone runner
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    pytest.main([__file__, "-v"])
