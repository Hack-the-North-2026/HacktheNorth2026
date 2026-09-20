"""
Fit Stealer — AI Service (FastAPI)
Perception tool server for the See and Crop pipeline steps.

Endpoints (Stage 1):
  POST /tools/see     — Baseten VLM → Garment[]
  POST /tools/crop    — PIL bbox cropper → chip files
  POST /tools/source-rank — Shopify Global Catalog → ranked matches
  POST /api/identify  — Fallback: see + crop in one call (before orchestrator)
  GET  /health        — Liveness probe

Architecture §7.2: This is a TOOL SERVER, not the product API.
It does not call Shopify, Composio, or the Expo app.
The Express orchestrator (backend/) owns the pipeline loop.
"""

from __future__ import annotations

import os
import logging
import tempfile
import time
import uuid
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from logging_config import agent_log, bind_job, configure_logging, garment_name, job_id_var

configure_logging()
logger = logging.getLogger("fit_stealer.api")

load_dotenv(Path(__file__).resolve().parent.parent / ".env")
load_dotenv()

# Import perception services
from services.baseten_vlm import analyze_frames_with_vlm  # noqa: E402
from services.cropper import crop_garments, prepare_image_for_see  # noqa: E402
from services.source_and_rank import source_and_rank  # noqa: E402
from services.video_processor import (  # noqa: E402
    cleanup_work_dir,
    extract_candidate_frames,
    select_and_identify_from_video,
    validate_video,
    ALLOWED_VIDEO_EXTENSIONS,
    MAX_VIDEO_SIZE_BYTES,
)

# Shared DSN with Expo and Express (root .env SENTRY_DSN)
_sentry_dsn = os.getenv("SENTRY_DSN") or ""
if _sentry_dsn:
    try:
        import sentry_sdk

        sentry_kwargs = {
            "dsn": _sentry_dsn,
            "traces_sample_rate": 1.0,
            "send_default_pii": False,
            "environment": os.getenv("NODE_ENV", "development"),
        }
        try:
            sentry_sdk.init(**sentry_kwargs, enable_logs=True)
        except TypeError:
            sentry_sdk.init(**sentry_kwargs)
        logger.info("Sentry tracing enabled")
    except Exception:
        logger.warning("Sentry SDK not available — pip install sentry-sdk")
else:
    logger.info("Sentry DSN not set — AI service tracing is off")

# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------
app = FastAPI(
    title="Fit Stealer AI Service",
    version="0.2.0",
    description="Perception tool server — See (Baseten VLM) and Crop (PIL) steps.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def request_logging(request, call_next):
    request_id = request.headers.get("x-request-id") or str(uuid.uuid4())
    bind_job(request.headers.get("x-job-id"))
    started = time.perf_counter()
    path = request.url.path
    try:
        response = await call_next(request)
    except Exception:
        took = round((time.perf_counter() - started) * 1000)
        logger.exception("HTTP %s %s crashed after %sms", request.method, path, took)
        raise
    response.headers["x-request-id"] = request_id
    if response.status_code < 400:
        return response
    if path in {"/", "/health"} or path.startswith("/json"):
        return response
    took = round((time.perf_counter() - started) * 1000)
    line = f"HTTP {response.status_code} {request.method} {path} ({took}ms)"
    if response.status_code >= 500:
        logger.error(line)
    else:
        logger.warning(line)
    return response

# Temp directory for uploaded images and chip output
_UPLOAD_DIR = Path(tempfile.gettempdir()) / "fit-stealer-uploads"
_CHIPS_DIR  = Path(tempfile.gettempdir()) / "fit-stealer-chips"
_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
_CHIPS_DIR.mkdir(parents=True, exist_ok=True)


@app.on_event("startup")
def on_startup():
    logger.info("AI service ready — See (Baseten) · Crop · Shopify · Rank (OpenAI) · Browserbase off")


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class CropRequest(BaseModel):
    image_path: str
    garments: list[dict]


class CropResponse(BaseModel):
    garments: list[dict]


class SeeResponse(BaseModel):
    garments: list[dict]
    outfit_summary: str
    image_path: str


class IdentifyResponse(BaseModel):
    garments: list[dict]
    outfit_summary: str
    image_path: str


class ChipPayload(BaseModel):
    content_type: str
    data: str


class SourceRankRequest(BaseModel):
    garment: dict
    chip: Optional[ChipPayload] = None


class SourceRankResponse(BaseModel):
    matches: list[dict]


class IngestResponse(BaseModel):
    garments: list[dict]
    outfit_summary: str
    frame_count: int
    selected_frames: int


class IdentifyVideoResponse(BaseModel):
    garments: list[dict]
    outfit_summary: str
    frame_count: int
    image_path: Optional[str] = None


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

@app.get("/")
@app.get("/health")
def health_check():
    return {
        "status": "ok",
        "service": "Fit Stealer AI Service",
        "version": "0.3.0",
        "sentry": "ok" if _sentry_dsn else "unconfigured",
        "endpoints": [
            "/tools/see",
            "/tools/crop",
            "/tools/ingest",
            "/tools/source-rank",
            "/api/identify",
            "/api/identify-video",
        ],
    }


# ---------------------------------------------------------------------------
# POST /tools/see
# Accepts a multipart image upload (or falls back to TEST_IMAGE_PATH env var).
# Calls Baseten VLM with OpenAI Structured Outputs.
# Returns { garments: Garment[], outfit_summary: str }
# ---------------------------------------------------------------------------

def _find_image_file(target: str) -> Path | None:
    p = Path(target)
    if p.exists():
        return p.resolve()
    ai_service_dir = Path(__file__).resolve().parent
    if (ai_service_dir / p).exists():
        return (ai_service_dir / p).resolve()
    if (ai_service_dir / p.name).exists():
        return (ai_service_dir / p.name).resolve()
    project_root = ai_service_dir.parent
    if (project_root / p).exists():
        return (project_root / p).resolve()
    if (project_root / p.name).exists():
        return (project_root / p.name).resolve()
    return None


@app.post("/tools/see", response_model=SeeResponse)
async def tools_see(
    image: Optional[UploadFile] = File(default=None),
):
    """
    See step — send one image to Baseten VLM, get back Garment[].

    Accepts:
      - multipart/form-data with field `image` (preferred, from Dev 2)
      - Falls back to TEST_IMAGE_PATH env var for Phase 1 local testing

    Returns:
      { garments: [...], outfit_summary: "..." }
    """
    if image is not None:
        suffix = Path(image.filename or "upload.jpg").suffix or ".jpg"
        file_id = str(uuid.uuid4())
        if not job_id_var.get():
            bind_job(file_id)
        raw_path = _UPLOAD_DIR / f"{file_id}-raw{suffix}"
        raw_path.write_bytes(await image.read())
        logger.info("see — preparing uploaded image")
        image_path = prepare_image_for_see(str(raw_path), str(_UPLOAD_DIR / f"{file_id}.jpg"))
        try:
            raw_path.unlink(missing_ok=True)
        except OSError:
            pass
    else:
        raw = os.getenv("TEST_IMAGE_PATH", "ai-service/test_outfit.png")
        found = _find_image_file(raw)
        if not found:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"No image uploaded and TEST_IMAGE_PATH '{raw}' does not exist. "
                    "Either POST an image file or set TEST_IMAGE_PATH in .env."
                ),
            )
        image_path = prepare_image_for_see(str(found), str(_UPLOAD_DIR / f"{uuid.uuid4()}.jpg"))

    try:
        result = analyze_frames_with_vlm([image_path])
    except ValueError as e:
        logger.warning("see — bad request: %s", e)
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("see — Baseten failed")
        raise HTTPException(status_code=502, detail=f"Baseten error: {e}")

    return SeeResponse(
        garments=result.get("garments", []),
        outfit_summary=result.get("outfit_summary", ""),
        image_path=image_path,
    )


# ---------------------------------------------------------------------------
# POST /tools/crop
# Accepts JSON { image_path, garments[] }.
# Runs PIL cropper on each garment bbox.
# Returns { garments: [...] } with chip_key set on each item.
# ---------------------------------------------------------------------------

@app.post("/tools/crop", response_model=CropResponse)
def tools_crop(body: CropRequest, request: Request):
    """
    Crop step — take normalized bbox coords from VLM, save .jpg chips.

    Accepts:
      { image_path: str, garments: Garment[] }

    Returns:
      { garments: Garment[] } with chip_key updated to saved file path.

    Note on downscaling (Phase 2 coordination with Dev 2):
      Pass the SAME image path that was analyzed by /tools/see.
      If Dev 2 downscales before sending to See, they must also send the
      downscaled image to Crop — not the original 4K file.
    """
    bind_job(request.headers.get("x-job-id"))
    image_path = body.image_path
    if not Path(image_path).exists():
        raise HTTPException(
            status_code=400,
            detail=f"image_path not found on this server: {image_path}",
        )

    try:
        updated = crop_garments(image_path, body.garments, str(_CHIPS_DIR))
    except Exception as e:
        logger.exception("crop — failed")
        raise HTTPException(status_code=500, detail=f"Crop error: {e}")

    return CropResponse(garments=updated)


# ---------------------------------------------------------------------------
# POST /tools/source-rank
# Accepts Dev 2's JSON { garment, chip?: { content_type, data } }.
# Runs Shopify Global Catalog sourcing followed by the OpenAI ranker.
# ---------------------------------------------------------------------------

@app.post("/tools/source-rank", response_model=SourceRankResponse)
def tools_source_rank(body: SourceRankRequest, request: Request):
    """Return at most three exact/similar matches for one garment."""
    bind_job(request.headers.get("x-job-id"))
    name = garment_name(body.garment)
    chip_base64 = body.chip.data if body.chip else None
    matches = source_and_rank(body.garment, chip_base64)
    logger.info("source — %s: returning %s matches", name, len(matches))
    return SourceRankResponse(matches=matches)


# ---------------------------------------------------------------------------
# POST /api/identify
# Stage 1 fallback: runs See + Crop in one call.
# Dev 2 can hit this endpoint until the full orchestrator loop is wired.
# Architecture §7.2: "the /api/identify fallback may call Shopify so Stage 1
# can demo before the Worker exists" — but Source/Rank is Dev 2/4's territory.
# This endpoint returns garments + chips only.
# ---------------------------------------------------------------------------

@app.post("/api/identify", response_model=IdentifyResponse)
async def api_identify(
    image: UploadFile = File(...),
):
    """
    Fallback identify — See + Crop in one call.

    Accepts:
      multipart/form-data with field `image`

    Returns:
      { garments: Garment[] (with chip_key), outfit_summary: str }

    This is NOT the final pipeline. It's a demo path for before the
    Express orchestrator wires /tools/see and /tools/crop separately.
    """
    suffix = Path(image.filename or "upload.jpg").suffix or ".jpg"
    file_id = str(uuid.uuid4())
    if not job_id_var.get():
        bind_job(file_id)
    raw_path = _UPLOAD_DIR / f"{file_id}-raw{suffix}"
    raw_path.write_bytes(await image.read())
    logger.info("see — preparing uploaded image")
    image_path = prepare_image_for_see(str(raw_path), str(_UPLOAD_DIR / f"{file_id}.jpg"))
    try:
        raw_path.unlink(missing_ok=True)
    except OSError:
        pass

    try:
        result = analyze_frames_with_vlm([image_path])
    except ValueError as e:
        logger.warning("see — bad request: %s", e)
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("see — Baseten failed")
        raise HTTPException(status_code=502, detail=f"Baseten error: {e}")

    garments = result.get("garments", [])
    outfit_summary = result.get("outfit_summary", "")

    try:
        garments = crop_garments(image_path, garments, str(_CHIPS_DIR))
    except Exception:
        logger.exception("crop — failed, returning garments without chips")

    return IdentifyResponse(
        garments=garments,
        outfit_summary=outfit_summary,
        image_path=image_path,
    )


# ---------------------------------------------------------------------------
# POST /tools/ingest
# Stage 3: Accept a video upload, extract keyframes, run VLM.
# Architecture §7.2: POST /tools/ingest — video_processor.py (frames from video)
# ---------------------------------------------------------------------------

@app.post("/tools/ingest", response_model=IngestResponse)
async def tools_ingest(
    video: UploadFile = File(...),
):
    """
    Ingest step (Stage 3) — extract keyframes from video, run VLM.

    Accepts:
      multipart/form-data with field `video` (.mp4, .mov, .webm)

    Returns:
      { garments: Garment[], outfit_summary: str, frame_count: int, selected_frames: int }
    """
    suffix = Path(video.filename or "upload.mp4").suffix.lower() or ".mp4"
    if suffix not in ALLOWED_VIDEO_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported video format '{suffix}'. Allowed: {', '.join(sorted(ALLOWED_VIDEO_EXTENSIONS))}",
        )

    file_id = str(uuid.uuid4())
    if not job_id_var.get():
        bind_job(file_id)

    video_path = _UPLOAD_DIR / f"{file_id}{suffix}"
    content = await video.read()

    if len(content) > MAX_VIDEO_SIZE_BYTES:
        raise HTTPException(
            status_code=400,
            detail=f"Video too large ({len(content) / 1024 / 1024:.1f} MB). Maximum: {MAX_VIDEO_SIZE_BYTES / 1024 / 1024:.0f} MB.",
        )

    video_path.write_bytes(content)
    logger.info("ingest — saved uploaded video (%s, %.1f MB)", suffix, len(content) / 1024 / 1024)

    try:
        result = select_and_identify_from_video(str(video_path))
    except ValueError as e:
        logger.warning("ingest — bad request: %s", e)
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError as e:
        logger.error("ingest — runtime error: %s", e)
        raise HTTPException(status_code=500, detail=str(e))
    except Exception as e:
        logger.exception("ingest — failed")
        raise HTTPException(status_code=502, detail=f"Video processing error: {e}")
    finally:
        # Clean up uploaded video
        try:
            video_path.unlink(missing_ok=True)
        except OSError:
            pass

    # Clean up working directory
    work_dir = result.get("candidate_dir", "")
    if work_dir:
        cleanup_work_dir(work_dir)

    return IngestResponse(
        garments=result.get("garments", []),
        outfit_summary=result.get("outfit_summary", ""),
        frame_count=result.get("frame_count", 0),
        selected_frames=result.get("selected_frames", 0),
    )


# ---------------------------------------------------------------------------
# POST /api/identify-video
# Stage 3 convenience: ingest + crop in one call.
# Mirrors /api/identify but for video input.
# ---------------------------------------------------------------------------

@app.post("/api/identify-video", response_model=IdentifyVideoResponse)
async def api_identify_video(
    video: UploadFile = File(...),
):
    """
    Stage 3 convenience — video ingest + crop in one call.

    Accepts:
      multipart/form-data with field `video`

    Returns:
      { garments: Garment[] (with chip_key), outfit_summary: str, frame_count: int }
    """
    suffix = Path(video.filename or "upload.mp4").suffix.lower() or ".mp4"
    if suffix not in ALLOWED_VIDEO_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported video format '{suffix}'. Allowed: {', '.join(sorted(ALLOWED_VIDEO_EXTENSIONS))}",
        )

    file_id = str(uuid.uuid4())
    if not job_id_var.get():
        bind_job(file_id)

    video_path = _UPLOAD_DIR / f"{file_id}{suffix}"
    content = await video.read()

    if len(content) > MAX_VIDEO_SIZE_BYTES:
        raise HTTPException(
            status_code=400,
            detail=f"Video too large ({len(content) / 1024 / 1024:.1f} MB). Maximum: {MAX_VIDEO_SIZE_BYTES / 1024 / 1024:.0f} MB.",
        )

    video_path.write_bytes(content)

    work_dir = ""
    try:
        result = select_and_identify_from_video(str(video_path))
        work_dir = result.get("candidate_dir", "")
        garments = result.get("garments", [])
        outfit_summary = result.get("outfit_summary", "")
        frame_count = result.get("frame_count", 0)

        # Crop chips from the best source frame for each garment
        representative_frame = None
        if work_dir:
            candidate_dir = os.path.join(work_dir, "candidates")
            candidate_files = sorted(Path(candidate_dir).glob("candidate_*.jpg"))
            if candidate_files:
                representative_frame = candidate_files[0]
            for g in garments:
                src_idx = g.get("source_frame_index")
                if src_idx is not None and 0 <= src_idx < len(candidate_files):
                    frame_path = str(candidate_files[src_idx])
                    if representative_frame is None or representative_frame == candidate_files[0]:
                        representative_frame = candidate_files[src_idx]
                    try:
                        cropped = crop_garments(frame_path, [g], str(_CHIPS_DIR))
                        if cropped:
                            g.update(cropped[0])
                    except Exception:
                        logger.debug("crop — failed for garment %s", g.get("id"))

        image_path = None
        if representative_frame and representative_frame.exists():
            thumb_dest = _CHIPS_DIR / f"thumb_{file_id}.jpg"
            thumb_dest.write_bytes(representative_frame.read_bytes())
            image_path = str(thumb_dest)
    except ValueError as e:
        logger.warning("identify-video — bad request: %s", e)
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("identify-video — failed")
        raise HTTPException(status_code=502, detail=f"Video identify error: {e}")
    finally:
        try:
            video_path.unlink(missing_ok=True)
        except OSError:
            pass
        if work_dir:
            cleanup_work_dir(work_dir)

    return IdentifyVideoResponse(
        garments=garments,
        outfit_summary=outfit_summary,
        frame_count=frame_count,
        image_path=image_path,
    )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("AI_SERVICE_PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
