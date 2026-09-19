"""Single Stage 1 entry point for Dev 2's orchestrator."""

from __future__ import annotations

from pathlib import Path
import logging
from typing import Any

from logging_config import agent_log, garment_name
from services.product_ranker import fallback_rank_candidates, rank_candidates
from services.shopify_filter import ShopifyCatalogError, encode_chip, search_shopify_catalog

logger = logging.getLogger("fit_stealer.source_rank")


def source_and_rank(
    garment: dict[str, Any], chip: str | Path | None = None
) -> list[dict[str, Any]]:
    """Source and rank one garment without failing the whole outfit."""
    name = garment_name(garment)
    try:
        chip_base64: str | None = None
        if isinstance(chip, Path):
            chip_base64 = encode_chip(chip)
        elif isinstance(chip, str) and chip:
            # A real base64 chip can be far longer than the OS filename limit.
            # Only probe short strings as paths; otherwise treat it as encoded data.
            possible_path = Path(chip)
            chip_base64 = (
                encode_chip(possible_path)
                if len(chip) < 1024 and possible_path.is_file()
                else chip
            )
        candidates = search_shopify_catalog(garment, chip_base64)
    except (OSError, ShopifyCatalogError, ValueError) as exc:
        logger.warning("shopify — %s: failed (%s)", name, exc)
        # #region agent log
        agent_log("D", "source_and_rank.py", "shopify failed", {"category": name, "error": str(exc)[:200]})
        # #endregion
        return []
    try:
        ranked = rank_candidates(garment, candidates)
        # #region agent log
        agent_log(
            "D",
            "source_and_rank.py",
            "source+rank complete",
            {"category": name, "candidates": len(candidates), "ranked": len(ranked), "fallback": False},
        )
        # #endregion
        return ranked
    except Exception:
        logger.exception("rank — %s: OpenAI failed, using local fallback", name)
        fallback = fallback_rank_candidates(garment, candidates)
        # #region agent log
        agent_log(
            "E",
            "source_and_rank.py",
            "rank fallback used",
            {"category": name, "candidates": len(candidates), "ranked": len(fallback), "fallback": True},
        )
        # #endregion
        return fallback
