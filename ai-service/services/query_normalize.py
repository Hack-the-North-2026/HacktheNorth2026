"""Canonicalize catalog search queries so the same garment hits the same Shopify `like`.

Stage A: lowercase, color aliases, drop filler. Idempotent.
"""

from __future__ import annotations

import re

FILLER = frozenset(
    {
        "a",
        "an",
        "the",
        "with",
        "and",
        "of",
        "for",
        "that",
        "this",
        "very",
        "really",
        "some",
        "just",
        "like",
        "featuring",
        "features",
        "style",
        "look",
        "piece",
        "clothing",
        "item",
        "wear",
        "worn",
        "mens",
        "womens",
        "menswear",
        "womenswear",
        "trendy",
        "cute",
        "nice",
        "cool",
        "aesthetic",
        "in",
        "on",
        "to",
        "from",
        "its",
        "plus",
        "including",
        "showing",
    }
)

# Longer phrases first so "navy blue" wins over "navy".
COLOR_ALIASES = {
    "navy blue": "navy",
    "dark grey": "dark-gray",
    "dark gray": "dark-gray",
    "light blue": "light-blue",
    "off white": "off-white",
    "olive green": "olive",
    "grey": "gray",
    "greyish": "gray",
    "navyblue": "navy",
    "offwhite": "off-white",
    "off-white": "off-white",
    "maroon": "burgundy",
    "wine": "burgundy",
    "olivegreen": "olive",
    "darkblue": "navy",
    "lightblue": "light-blue",
}


def canonicalize_query(query: str | None) -> str:
    """Lowercase, alias colors, drop filler words, collapse whitespace."""
    text = str(query or "").lower()
    if not text.strip():
        return ""
    text = text.replace("&", " and ")
    text = re.sub(r"[^\w\s-]", " ", text)
    text = re.sub(r"-{2,}", "-", text)
    text = re.sub(r"\s+", " ", text).strip()

    tokens = [tok.strip("-") for tok in text.split() if tok.strip("-")]
    out: list[str] = []
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        pair = f"{tok} {tokens[i + 1]}" if i + 1 < len(tokens) else ""
        alias = None
        consumed = 1
        if pair:
            pair_key = pair.replace(" ", "").replace("-", "")
            alias = COLOR_ALIASES.get(pair) or COLOR_ALIASES.get(pair_key)
            if alias:
                consumed = 2
        if alias is None:
            key = tok.replace("-", "")
            if tok in FILLER or key in FILLER:
                i += 1
                continue
            alias = COLOR_ALIASES.get(tok) or COLOR_ALIASES.get(key) or tok
        if alias not in out:
            out.append(alias)
        i += consumed
    return " ".join(out)


def unique_queries(*parts: str | None, limit: int = 3) -> list[str]:
    """Canonicalize and drop duplicate catalog queries, keeping order."""
    out: list[str] = []
    for part in parts:
        query = canonicalize_query(part)
        if query and query not in out:
            out.append(query)
        if len(out) >= limit:
            break
    return out


def garment_catalog_queries(garment: dict | None, limit: int = 3) -> list[str]:
    """Primary / distinctive / brand queries from SeeChip, then search_query."""
    garment = garment or {}
    extra = garment.get("queries") if isinstance(garment.get("queries"), list) else []
    return unique_queries(
        *[str(item) for item in extra if item],
        garment.get("search_query"),
        garment.get("description"),
        limit=limit,
    )


def reformulate_garment(garment: dict | None) -> dict:
    """Rotate queries so the distinctive/brand search runs first on a retry."""
    out = dict(garment or {})
    queries = garment_catalog_queries(out)
    if len(queries) < 2:
        return out
    rotated = queries[1:] + queries[:1]
    out["queries"] = rotated
    out["search_query"] = rotated[0]
    return out


def like_query(garment: dict | None, primary: str = "") -> str:
    """Short color + material + category query for Shopify ``like`` search."""
    garment = garment or {}
    attrs = garment.get("attributes") if isinstance(garment.get("attributes"), dict) else {}
    color = canonicalize_query(str(attrs.get("color") or ""))
    material = canonicalize_query(str(attrs.get("material") or ""))
    category = canonicalize_query(str(garment.get("category") or ""))
    skip = {"unknown", "other", "none"}
    parts: list[str] = []
    for token in (color, material, category):
        if token and token not in skip and token not in parts:
            parts.append(token)
    if parts:
        return " ".join(parts)
    tokens = canonicalize_query(primary).split()[:4]
    return " ".join(tokens)
