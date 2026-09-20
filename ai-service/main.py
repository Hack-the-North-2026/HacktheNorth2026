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
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from logging_config import configure_logging

configure_logging()
logger = logging.getLogger("fit_stealer.api")

load_dotenv(Path(__file__).resolve().parent.parent / ".env", override=True)
load_dotenv(override=True)

# Import perception services
from services.baseten_vlm import analyze_frames_with_vlm  # noqa: E402
from services.cropper import crop_garments, prepare_image_for_see  # noqa: E402
from services.source_and_rank import source_and_rank  # noqa: E402

_sentry_dsn = os.getenv("SENTRY_DSN")
if _sentry_dsn:
    try:
        import sentry_sdk

        sentry_sdk.init(dsn=_sentry_dsn, traces_sample_rate=1.0, send_default_pii=False)
    except Exception:
        pass

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
    started = time.perf_counter()
    try:
        response = await call_next(request)
    except Exception:
        logger.exception(
            "http.unhandled",
            extra={
                "context": {
                    "request_id": request_id,
                    "method": request.method,
                    "path": request.url.path,
                    "duration_ms": round((time.perf_counter() - started) * 1000),
                }
            },
        )
        raise
    response.headers["x-request-id"] = request_id
    context = {
        "request_id": request_id,
        "method": request.method,
        "path": request.url.path,
        "status": response.status_code,
        "duration_ms": round((time.perf_counter() - started) * 1000),
    }
    if response.status_code >= 500:
        logger.error("http.request", extra={"context": context})
    elif response.status_code >= 400:
        logger.warning("http.request", extra={"context": context})
    else:
        logger.info("http.request", extra={"context": context})
    return response

# Temp directory for uploaded images and chip output
_UPLOAD_DIR = Path(tempfile.gettempdir()) / "fit-stealer-uploads"
_CHIPS_DIR  = Path(tempfile.gettempdir()) / "fit-stealer-chips"
_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
_CHIPS_DIR.mkdir(parents=True, exist_ok=True)


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


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

@app.get("/")
@app.get("/health")
def health_check():
    return {
        "status": "ok",
        "service": "Fit Stealer AI Service",
        "version": "0.2.0",
        "endpoints": [
            "/tools/see",
            "/tools/crop",
            "/tools/source-rank",
            "/api/identify",
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
        job_id = str(uuid.uuid4())
        raw_path = _UPLOAD_DIR / f"{job_id}-raw{suffix}"
        raw_path.write_bytes(await image.read())
        image_path = prepare_image_for_see(str(raw_path), str(_UPLOAD_DIR / f"{job_id}.jpg"))
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
        logger.warning("see.invalid_request", extra={"context": {"error": str(e)}})
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("see.failed")
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
def tools_crop(body: CropRequest):
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
    image_path = body.image_path
    if not Path(image_path).exists():
        raise HTTPException(
            status_code=400,
            detail=f"image_path not found on this server: {image_path}",
        )

    try:
        updated = crop_garments(image_path, body.garments, str(_CHIPS_DIR))
    except Exception as e:
        logger.exception("crop.failed")
        raise HTTPException(status_code=500, detail=f"Crop error: {e}")

    return CropResponse(garments=updated)


# ---------------------------------------------------------------------------
# POST /tools/source-rank
# Accepts Dev 2's JSON { garment, chip?: { content_type, data } }.
# Runs Shopify Global Catalog sourcing followed by the OpenAI ranker.
# ---------------------------------------------------------------------------

@app.post("/tools/source-rank", response_model=SourceRankResponse)
def tools_source_rank(body: SourceRankRequest):
    """Return at most three exact/similar matches for one garment."""
    chip_base64 = body.chip.data if body.chip else None
    matches = source_and_rank(body.garment, chip_base64)
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
    job_id = str(uuid.uuid4())
    raw_path = _UPLOAD_DIR / f"{job_id}-raw{suffix}"
    raw_path.write_bytes(await image.read())
    image_path = prepare_image_for_see(str(raw_path), str(_UPLOAD_DIR / f"{job_id}.jpg"))
    try:
        raw_path.unlink(missing_ok=True)
    except OSError:
        pass

    try:
        result = analyze_frames_with_vlm([image_path])
    except ValueError as e:
        logger.warning("identify.invalid_request", extra={"context": {"error": str(e)}})
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("identify.see_failed")
        raise HTTPException(status_code=502, detail=f"Baseten error: {e}")

    garments = result.get("garments", [])
    outfit_summary = result.get("outfit_summary", "")

    try:
        garments = crop_garments(image_path, garments, str(_CHIPS_DIR))
    except Exception as e:
        logger.exception("identify.crop_failed")

    return IdentifyResponse(
        garments=garments,
        outfit_summary=outfit_summary,
        image_path=image_path,
    )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("AI_SERVICE_PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
