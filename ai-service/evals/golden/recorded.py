"""Recorded IdentifyResult runs for the 10-image golden set.

Each case has three identical runs so Jaccard(garments)=1 and top URL is
stable. Live `--live` mode replaces these with real `/api/identify` jobs.
"""

from __future__ import annotations

from typing import Any


def _garment(
    ident: str,
    category: str,
    description: str,
    query: str,
    *,
    queries: list[str] | None = None,
    brand: str | None = None,
    brand_cues: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "id": ident,
        "category": category,
        "description": description,
        "search_query": query,
        "queries": queries or [query],
        "attributes": {"color": "unknown"},
        "brand": brand,
        "brand_cues": brand_cues or [],
        "confidence": 0.9,
        "bbox": [0.1, 0.1, 0.6, 0.6],
        "chip_key": "",
        "accessibility_line": description,
    }


def _match(
    title: str,
    url: str,
    *,
    match_type: str = "similar",
    visual: float | None = 0.7,
    source: str = "shopify",
) -> dict[str, Any]:
    row: dict[str, Any] = {
        "title": title,
        "url": url,
        "image_url": "https://cdn.example/p.jpg",
        "price": "89.00",
        "currency": "CAD",
        "store_name": "Example",
        "source": source,
        "match_type": match_type,
        "confidence": 0.88 if match_type == "exact" else 0.7,
        "reason": "Visual compare against the chip." if match_type == "exact" else "Similar silhouette.",
    }
    if visual is not None:
        row["visual_score"] = visual
        row["visual_label"] = "same_item" if visual >= 0.82 else "similar"
    return row


def _result(case_id: str, items: list[dict[str, Any]], summary: str = "") -> dict[str, Any]:
    return {
        "job_id": case_id,
        "status": "done",
        "origin": "app",
        "outfit_summary": summary,
        "items": items,
        "steps": [
            {"status": "seeing", "at": "2026-09-19T00:00:00Z"},
            {"status": "done", "at": "2026-09-19T00:00:10Z"},
        ],
    }


def _three(build) -> list[dict[str, Any]]:
    return [build() for _ in range(3)]


def recorded_runs() -> dict[str, list[dict[str, Any]]]:
    jacket = _garment(
        "jacket-04-02-12-16",
        "jacket",
        "oversized black leather biker jacket silver zip",
        "oversized black leather biker jacket silver zip",
        queries=[
            "oversized black leather biker jacket",
            "black leather biker silver zip hardware",
        ],
    )
    hoodie = _garment(
        "shirt-06-04-14-18",
        "shirt",
        "navy hoodie with readable logo",
        "navy hoodie",
        queries=["navy hoodie", "navy hoodie chest logo"],
        brand_cues=["logo text on chest"],
    )
    tee = _garment(
        "shirt-08-05-12-14",
        "shirt",
        "plain white cotton t-shirt",
        "white cotton t-shirt",
        queries=["white cotton t-shirt"],
    )
    zip_ = _garment(
        "jacket-05-03-13-15",
        "jacket",
        "cream quarter-zip fleece",
        "cream quarter zip fleece",
        queries=["cream quarter zip fleece", "cream fleece quarter zip"],
    )
    denim = _garment(
        "pants-10-12-08-22",
        "pants",
        "light wash straight-leg denim",
        "light wash straight leg denim",
        queries=["light wash straight leg denim"],
    )
    bomber = _garment(
        "jacket-03-02-11-15",
        "jacket",
        "black leather bomber silver hardware",
        "black leather bomber jacket silver hardware",
        queries=["black leather bomber jacket", "silver zip leather bomber"],
    )
    pants = _garment(
        "pants-09-14-10-24",
        "pants",
        "wide-leg washed trousers",
        "wide-leg washed trousers",
        queries=["wide-leg washed trousers"],
    )
    shoes = _garment(
        "shoes-16-18-08-22",
        "shoes",
        "white leather sneakers",
        "white leather sneakers",
        queries=["white leather sneakers"],
    )
    jacket_b = _garment(
        "jacket-04-02-12-16",
        "jacket",
        "black leather biker jacket",
        "black leather biker jacket",
        queries=["black leather biker jacket", "leather biker silver zip"],
    )
    pants_b = _garment(
        "pants-10-12-08-22",
        "pants",
        "light wash denim",
        "light wash denim jeans",
        queries=["light wash denim jeans"],
    )

    return {
        "distinctive-leather-jacket": _three(
            lambda: _result(
                "distinctive-leather-jacket",
                [
                    {
                        "garment": jacket,
                        "matches": [
                            _match(
                                "Leather Biker Jacket",
                                "https://shop.example/biker",
                                match_type="exact",
                                visual=0.91,
                            )
                        ],
                    }
                ],
                "black leather biker",
            )
        ),
        "logo-hoodie": _three(
            lambda: _result(
                "logo-hoodie",
                [
                    {
                        "garment": hoodie,
                        "matches": [
                            _match(
                                "Navy Logo Hoodie",
                                "https://shop.example/hoodie",
                                match_type="exact",
                                visual=0.86,
                            )
                        ],
                    }
                ],
                "navy hoodie with logo",
            )
        ),
        "generic-white-tee": _three(
            lambda: _result(
                "generic-white-tee",
                [
                    {
                        "garment": tee,
                        "matches": [
                            _match(
                                "White Tee",
                                "https://shop.example/tee",
                                match_type="similar",
                                visual=0.61,
                            )
                        ],
                    }
                ],
                "plain white tee",
            )
        ),
        "no-clothes": _three(lambda: _result("no-clothes", [], "")),
        "cream-quarter-zip": _three(
            lambda: _result(
                "cream-quarter-zip",
                [
                    {
                        "garment": zip_,
                        "matches": [
                            _match(
                                "Cream Quarter Zip",
                                "https://shop.example/zip",
                                match_type="similar",
                                visual=0.72,
                            )
                        ],
                    }
                ],
                "cream quarter zip",
            )
        ),
        "washed-denim": _three(
            lambda: _result(
                "washed-denim",
                [
                    {
                        "garment": denim,
                        "matches": [
                            _match(
                                "Straight Jean",
                                "https://shop.example/jean",
                                match_type="similar",
                                visual=0.68,
                            )
                        ],
                    }
                ],
                "light wash denim",
            )
        ),
        "silver-hardware-bomber": _three(
            lambda: _result(
                "silver-hardware-bomber",
                [
                    {
                        "garment": bomber,
                        "matches": [
                            _match(
                                "Leather Bomber",
                                "https://shop.example/bomber",
                                match_type="exact",
                                visual=0.88,
                            )
                        ],
                    }
                ],
                "leather bomber",
            )
        ),
        "wide-leg-pants": _three(
            lambda: _result(
                "wide-leg-pants",
                [
                    {
                        "garment": pants,
                        "matches": [
                            _match(
                                "Wide Leg Trouser",
                                "https://shop.example/wideleg",
                                match_type="similar",
                                visual=0.64,
                            )
                        ],
                    }
                ],
                "wide-leg trousers",
            )
        ),
        "sneakers": _three(
            lambda: _result(
                "sneakers",
                [
                    {
                        "garment": shoes,
                        "matches": [
                            _match(
                                "White Sneaker",
                                "https://shop.example/sneaker",
                                match_type="similar",
                                visual=0.66,
                            )
                        ],
                    }
                ],
                "white sneakers",
            )
        ),
        "multi-piece-outfit": _three(
            lambda: _result(
                "multi-piece-outfit",
                [
                    {
                        "garment": jacket_b,
                        "matches": [
                            _match(
                                "Leather Biker Jacket",
                                "https://shop.example/biker",
                                match_type="exact",
                                visual=0.91,
                            ),
                            _match(
                                "Faux Moto",
                                "https://shop.example/moto",
                                match_type="similar",
                                visual=0.7,
                            ),
                        ],
                    },
                    {
                        "garment": pants_b,
                        "matches": [
                            _match(
                                "Straight Jean",
                                "https://shop.example/jean",
                                match_type="similar",
                                visual=0.68,
                            )
                        ],
                    },
                ],
                "leather jacket over denim",
            )
        ),
    }
