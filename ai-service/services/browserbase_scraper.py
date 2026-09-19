"""
Browserbase Scraper Service
Handles reverse image search and scraping using Browserbase headless agents.
"""

import logging

logger = logging.getLogger("fit_stealer.browserbase")


def search_products_with_browserbase(item_description: str, image_url: str = None):
    """
    Scrapes web stores / reverse searches images using Browserbase agents.
    """
    logger.info("browserbase — starting search for %s", item_description or "item")
    logger.warning("browserbase — not wired yet, skipping")
    return []
