"""Single Stage 1 entry point for Dev 2's orchestrator."""

from __future__ import annotations

from pathlib import Path
import logging
from typing import Any

from logging_config import agent_log, garment_name
from services.product_ranker import fallback_rank_candidates, rank_candidates
from services.query_normalize import canonicalize_query
from services.retrieval import retrieve_candidates
from services.shopify_filter import encode_chip
from services.visual_judge import judge_candidates

logger = logging.getLogger("fit_stealer.source_rank")


def _chip_base64(chip: str | Path | None) -> str | None:
    if isinstance(chip, Path):
        return encode_chip(chip)
    if isinstance(chip, str) and chip:
        # A real base64 chip can be far longer than the OS filename limit.
        # Only probe short strings as paths; otherwise treat it as encoded data.
        possible_path = Path(chip)
        if len(chip) < 1024 and possible_path.is_file():
            return encode_chip(possible_path)
        return chip
    return None


def source_and_rank(
    garment: dict[str, Any], chip: str | Path | None = None
) -> list[dict[str, Any]]:
    """Source and rank one garment without failing the whole outfit."""
    garment = dict(garment)
    garment["search_query"] = canonicalize_query(
        garment.get("search_query") or garment.get("description") or ""
    )
    name = garment_name(garment)
    chip_base64 = None
    try:
        chip_base64 = _chip_base64(chip)
        candidates = retrieve_candidates(garment, chip_base64)
    except (OSError, ValueError) as exc:
        logger.warning("source — %s: failed (%s)", name, exc)
        agent_log("D", "source_and_rank.py", "retrieve failed", {"category": name, "error": str(exc)[:200]})
        return []

    visual_scores: list[dict[str, Any]] = []
    has_chip = bool(chip_base64) or (
        isinstance(garment.get("chip_key"), str) and Path(str(garment.get("chip_key"))).is_file()
    )
    if has_chip and candidates:
        try:
            visual_scores = judge_candidates(chip, candidates, garment)
        except Exception:
            logger.exception("judge — %s: visual compare failed, using similar-only fallback", name)
            fallback = fallback_rank_candidates(garment, candidates)
            agent_log(
                "E",
                "source_and_rank.py",
                "visual judge failed",
                {"category": name, "candidates": len(candidates), "ranked": len(fallback)},
            )
            return fallback
        if not visual_scores:
            logger.info("judge — %s: no visual scores, similar-only fallback", name)
            fallback = fallback_rank_candidates(garment, candidates)
            agent_log(
                "E",
                "source_and_rank.py",
                "visual judge empty",
                {"category": name, "candidates": len(candidates), "ranked": len(fallback)},
            )
            return fallback

    try:
        ranked = rank_candidates(garment, candidates, visual_scores=visual_scores)
        agent_log(
            "D",
            "source_and_rank.py",
            "source+rank complete",
            {
                "category": name,
                "candidates": len(candidates),
                "ranked": len(ranked),
                "visualScores": len(visual_scores),
                "sources": [item.get("source") for item in ranked],
                "fallback": False,
            },
        )
        return ranked
    except Exception:
        logger.exception("rank — %s: OpenAI failed, using local fallback", name)
        fallback = fallback_rank_candidates(garment, candidates)
        agent_log(
            "E",
            "source_and_rank.py",
            "rank fallback used",
            {"category": name, "candidates": len(candidates), "ranked": len(fallback), "fallback": True},
        )
        return fallback
