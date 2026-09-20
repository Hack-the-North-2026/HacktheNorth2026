"""
Fit Stealer — AI Service (FastAPI)
Perception + matching tool server.

Endpoints:
  POST /tools/see         — Baseten VLM → Garment[]
  POST /tools/crop        — PIL bbox cropper → chip files
  POST /tools/see-chip    — Baseten close-up + OpenAI query merge
  POST /tools/retrieve    — Shopify fan-out (+ Composio if thin)
  POST /tools/judge       — VisualJudge chip vs product photos
  POST /tools/browse      — Browserbase reverse-image (weak scores only)
  POST /tools/rank        — OpenAI honesty ranker
  POST /tools/source-rank — Combined retrieve → judge → maybe browse → rank
  POST /api/identify      — See + crop (+ SeeChip unless detail=0)
  GET  /health            — Liveness probe

Architecture §7.2: This is a TOOL SERVER, not the product API.
Express / Cloudflare IdentifyAgent own the job loop and call these tools.
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
from fastapi import FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from logging_config import agent_log, bind_job, configure_logging, garment_name, job_id_var

configure_logging()
logger = logging.getLogger("fit_stealer.api")

load_dotenv(Path(__file__).resolve().parent.parent / ".env")
load_dotenv()

# Import perception services
from services.baseten_vlm import analyze_frames_with_vlm  # noqa: E402
from services.cropper import crop_garments, managed_media_path, prepare_image_for_see  # noqa: E402
from services.see_chip import detail_garments  # noqa: E402
from services.browserbase_scraper import browse_products  # noqa: E402
from services.product_ranker import fallback_rank_candidates, rank_candidates  # noqa: E402
from services.retrieval import retrieve_candidates  # noqa: E402
from services.shopify_filter import encode_chip  # noqa: E402
from services.source_and_rank import source_and_rank  # noqa: E402
from services.visual_judge import best_visual_score, judge_candidates  # noqa: E402

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
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

_TOOL_KEY = os.getenv("TOOL_SERVER_SECRET", "").strip()


@app.middleware("http")
async def tool_auth(request: Request, call_next):
    if not _TOOL_KEY:
        return await call_next(request)
    if request.method == "OPTIONS" or request.url.path in {"/", "/health"}:
        return await call_next(request)
    if request.headers.get("x-tool-key") != _TOOL_KEY:
        return JSONResponse({"detail": "Unauthorized"}, status_code=401)
    return await call_next(request)


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
    logger.info(
        "AI service ready — SeeScene · SeeChip · VisualJudge · retrieve/judge/browse/rank · "
        "Shopify fan-out · Composio · Browserbase reverse-image"
    )


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


class SeeChipRequest(BaseModel):
    garments: list[dict]


class SeeChipResponse(BaseModel):
    garments: list[dict]


class RetrieveRequest(BaseModel):
    garment: dict
    chip: Optional[ChipPayload] = None


class RetrieveResponse(BaseModel):
    candidates: list[dict]


class JudgeRequest(BaseModel):
    garment: dict
    candidates: list[dict] = []
    chip: Optional[ChipPayload] = None


class JudgeResponse(BaseModel):
    visual_scores: list[dict]
    best: Optional[float] = None


class BrowseRequest(BaseModel):
    garment: dict
    chip: Optional[ChipPayload] = None


class BrowseResponse(BaseModel):
    candidates: list[dict]


class RankRequest(BaseModel):
    garment: dict
    candidates: list[dict] = []
    visual_scores: Optional[list[dict]] = None


class RankResponse(BaseModel):
    matches: list[dict]


def _chip_b64(body: SourceRankRequest | RetrieveRequest | JudgeRequest | BrowseRequest) -> str | None:
    """Prefer uploaded chip bytes; fall back to a FastAPI-local chip_key path."""
    if body.chip and body.chip.data:
        return body.chip.data
    key = body.garment.get("chip_key") if isinstance(body.garment, dict) else None
    managed = managed_media_path(key if isinstance(key, str) else None)
    if managed:
        try:
            return encode_chip(managed)
        except Exception:
            return None
    return None


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
        "sentry": "ok" if _sentry_dsn else "unconfigured",
        "endpoints": [
            "/tools/see",
            "/tools/crop",
            "/tools/see-chip",
            "/tools/retrieve",
            "/tools/judge",
            "/tools/browse",
            "/tools/rank",
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
    image_path = managed_media_path(body.image_path)
    if image_path is None:
        raise HTTPException(
            status_code=400,
            detail="image_path is missing or is not a Fit Stealer upload on this server",
        )

    try:
        updated = crop_garments(str(image_path), body.garments, str(_CHIPS_DIR))
    except Exception as e:
        logger.exception("crop — failed")
        raise HTTPException(status_code=500, detail=f"Crop error: {e}")

    return CropResponse(garments=updated)


# ---------------------------------------------------------------------------
# POST /tools/see-chip
# Accepts JSON { garments[] } with chip_key paths from /tools/crop.
# Second Baseten pass on each crop, OpenAI merge of queries/attributes.
# ---------------------------------------------------------------------------

@app.post("/tools/see-chip", response_model=SeeChipResponse)
def tools_see_chip(body: SeeChipRequest, request: Request):
    """Chip-first See — overwrite scene copy with close-up garment details."""
    bind_job(request.headers.get("x-job-id"))
    if not body.garments:
        return SeeChipResponse(garments=[])
    try:
        updated = detail_garments(body.garments)
    except ValueError as e:
        logger.warning("see-chip — bad request: %s", e)
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("see-chip — failed")
        raise HTTPException(status_code=502, detail=f"SeeChip error: {e}")
    return SeeChipResponse(garments=updated)


# ---------------------------------------------------------------------------
# POST /tools/source-rank
# Accepts Dev 2's JSON { garment, chip?: { content_type, data } }.
# Stage D: 2–3 Shopify searches in parallel, Composio if thin, then VisualJudge + rank.
# ---------------------------------------------------------------------------

@app.post("/tools/retrieve", response_model=RetrieveResponse)
def tools_retrieve(body: RetrieveRequest, request: Request):
    """Shopify fan-out (+ Composio if thin). No ranking."""
    bind_job(request.headers.get("x-job-id"))
    name = garment_name(body.garment)
    try:
        candidates = retrieve_candidates(body.garment, _chip_b64(body))
    except Exception:
        logger.warning("retrieve — %s: catalog search failed", name, exc_info=True)
        candidates = []
    logger.info("retrieve — %s: %s candidates", name, len(candidates))
    return RetrieveResponse(candidates=candidates)


@app.post("/tools/judge", response_model=JudgeResponse)
def tools_judge(body: JudgeRequest, request: Request):
    """VisualJudge: chip vs product photos. Empty scores if vision cannot run."""
    bind_job(request.headers.get("x-job-id"))
    name = garment_name(body.garment)
    try:
        scores = judge_candidates(_chip_b64(body), body.candidates, body.garment)
    except Exception:
        logger.warning("judge — %s: visual compare failed", name, exc_info=True)
        scores = []
    best = best_visual_score(scores)
    logger.info(
        "judge — %s: %s scores, best %s",
        name,
        len(scores),
        f"{best:.2f}" if isinstance(best, float) else "none",
    )
    return JudgeResponse(visual_scores=scores, best=best)


@app.post("/tools/browse", response_model=BrowseResponse)
def tools_browse(body: BrowseRequest, request: Request):
    """Browserbase reverse-image / shopping extract. Empty if skipped or failed."""
    bind_job(request.headers.get("x-job-id"))
    name = garment_name(body.garment)
    try:
        candidates = browse_products(body.garment, _chip_b64(body))
    except Exception:
        logger.warning("browse — %s: reverse-image failed", name, exc_info=True)
        candidates = []
    logger.info("browse — %s: %s listings", name, len(candidates))
    return BrowseResponse(candidates=candidates)


@app.post("/tools/rank", response_model=RankResponse)
def tools_rank(body: RankRequest, request: Request):
    """OpenAI honesty ranker. Similar-only fallback if the ranker fails."""
    bind_job(request.headers.get("x-job-id"))
    name = garment_name(body.garment)
    try:
        matches = rank_candidates(
            body.garment,
            body.candidates,
            visual_scores=body.visual_scores,
        )
    except Exception:
        logger.warning("rank — %s: OpenAI failed, using local fallback", name, exc_info=True)
        matches = fallback_rank_candidates(body.garment, body.candidates)
    logger.info("rank — %s: returning %s matches", name, len(matches))
    return RankResponse(matches=matches)


@app.post("/tools/source-rank", response_model=SourceRankResponse)
def tools_source_rank(body: SourceRankRequest, request: Request):
    """Return at most three exact/similar matches for one garment."""
    bind_job(request.headers.get("x-job-id"))
    name = garment_name(body.garment)
    matches = source_and_rank(body.garment, _chip_b64(body))
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
    detail: bool = Query(True),
):
    """
    Fallback identify — See + Crop in one call.

    Query:
      detail=1 (default) also runs SeeChip.
      detail=0 stops after crop so the orchestrator can expose a detailing status.
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

    if detail:
        try:
            garments = detail_garments(garments)
        except Exception:
            logger.exception("see-chip — failed, using scene descriptions")

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
    host = os.getenv("AI_SERVICE_HOST", "127.0.0.1")
    uvicorn.run("main:app", host=host, port=port, reload=True)
