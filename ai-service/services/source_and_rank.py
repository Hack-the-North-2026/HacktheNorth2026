"""Single Stage 1 entry point for Dev 2's orchestrator."""

from __future__ import annotations

from pathlib import Path
import logging
from typing import Any

from logging_config import agent_log, garment_name
from services.browserbase_scraper import browse_products, should_browse
from services.cropper import managed_media_path
from services.product_ranker import fallback_rank_candidates, rank_candidates
from services.query_normalize import canonicalize_query, reformulate_garment
from services.retrieval import dedupe_candidates, prefer_judgeable, retrieve_candidates
from services.shopify_filter import encode_chip
from services.visual_judge import best_visual_score, judge_candidates, needs_reformulate

logger = logging.getLogger("fit_stealer.source_rank")


def _chip_base64(chip: str | Path | None) -> str | None:
    if isinstance(chip, Path):
        managed = managed_media_path(str(chip))
        return encode_chip(managed) if managed else None
    if isinstance(chip, str) and chip:
        managed = managed_media_path(chip)
        if managed:
            return encode_chip(managed)
        return chip
    return None


def _merge_browse(
    catalog: list[dict[str, Any]], browsed: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Keep Shopify URLs, append Browserbase hits, put new photos first for re-judge."""
    merged = dedupe_candidates(list(catalog) + list(browsed))
    fresh = {str(item.get("url") or "") for item in browsed}
    browserbase = [
        item for item in merged if item.get("source") == "browserbase" or str(item.get("url") or "") in fresh
    ]
    rest = [item for item in merged if item not in browserbase]
    return prefer_judgeable(browserbase + rest)


def _judge(
    chip: str | Path | None,
    candidates: list[dict[str, Any]],
    garment: dict[str, Any],
    name: str,
) -> list[dict[str, Any]]:
    try:
        return judge_candidates(chip, candidates, garment)
    except Exception:
        logger.exception("judge — %s: visual compare failed", name)
        return []


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
    has_chip = bool(chip_base64)
    if has_chip and candidates:
        visual_scores = _judge(chip, candidates, garment, name)

    if needs_reformulate(best_visual_score(visual_scores)):
        logger.info("source — %s: mid-band visual, retrying distinctive query", name)
        try:
            extra = retrieve_candidates(reformulate_garment(garment), chip_base64)
        except (OSError, ValueError) as exc:
            logger.warning("source — %s: reformulate failed (%s)", name, exc)
            extra = []
        if extra:
            candidates = prefer_judgeable(dedupe_candidates(list(candidates) + list(extra)))
            if has_chip and candidates:
                visual_scores = _judge(chip, candidates, garment, name)

    browsed: list[dict[str, Any]] = []
    if should_browse(visual_scores, candidates):
        logger.info(
            "source — %s: visual %s, opening Browserbase reverse-image",
            name,
            f"{best_visual_score(visual_scores):.2f}" if best_visual_score(visual_scores) is not None else "none",
        )
        try:
            browsed = browse_products(garment, chip)
        except Exception:
            logger.exception("browserbase — %s: extract failed, keeping catalog matches", name)
            browsed = []
        if browsed:
            candidates = _merge_browse(candidates, browsed)
            if has_chip and candidates:
                visual_scores = _judge(chip, candidates, garment, name)

    if has_chip and candidates and not visual_scores:
        logger.info("judge — %s: no visual scores, similar-only fallback", name)
        fallback = fallback_rank_candidates(garment, candidates)
        agent_log(
            "E",
            "source_and_rank.py",
            "visual judge empty",
            {
                "category": name,
                "candidates": len(candidates),
                "browsed": len(browsed),
                "ranked": len(fallback),
            },
        )
        return fallback

    try:
        ranked = rank_candidates(garment, candidates, visual_scores=visual_scores)
        agent_log(
            "E",
            "source_and_rank.py",
            "source+rank complete",
            {
                "category": name,
                "candidates": len(candidates),
                "ranked": len(ranked),
                "visualScores": len(visual_scores),
                "bestVisual": best_visual_score(visual_scores),
                "browsed": len(browsed),
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
