"""Single Stage 1 entry point for Dev 2's orchestrator."""

from __future__ import annotations

from pathlib import Path
import logging
from typing import Any

from services.product_ranker import fallback_rank_candidates, rank_candidates
from services.shopify_filter import ShopifyCatalogError, encode_chip, search_shopify_catalog

logger = logging.getLogger("fit_stealer.source_rank")


def source_and_rank(
    garment: dict[str, Any], chip: str | Path | None = None
) -> list[dict[str, Any]]:
    """Source and rank one garment without failing the whole outfit."""
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
        logger.warning(
            "shopify.failed",
            extra={"context": {"garment_id": garment.get("id", "?"), "error": str(exc)}},
        )
        return []
    try:
        return rank_candidates(garment, candidates)
    except Exception as exc:
        logger.exception(
            "rank.failed_using_fallback",
            extra={"context": {"garment_id": garment.get("id", "?")}},
        )
        return fallback_rank_candidates(garment, candidates)
