"""Recorded IdentifyResult runs for the short-video golden set.

Each case has three identical runs so Jaccard(garments)=1 and top URL is
stable. Live `--live --videos` replaces these with real `/api/identify` jobs.
No Baseten calls here — ingest/see outcomes are fixtures.
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
    brand_cues: list[str] | None = None,
    source_frame_index: int = 0,
) -> dict[str, Any]:
    return {
        "id": ident,
        "category": category,
        "description": description,
        "search_query": query,
        "queries": queries or [query],
        "attributes": {"color": "unknown"},
        "brand": None,
        "brand_cues": brand_cues or [],
        "confidence": 0.9,
        "bbox": [0.2, 0.1, 0.8, 0.7],
        "chip_key": "",
        "accessibility_line": description,
        "source_frame_index": source_frame_index,
    }


def _match(
    title: str,
    url: str,
    *,
    match_type: str = "similar",
    visual: float | None = 0.7,
) -> dict[str, Any]:
    row: dict[str, Any] = {
        "title": title,
        "url": url,
        "image_url": "https://cdn.example/p.jpg",
        "price": "89.00",
        "currency": "CAD",
        "store_name": "Example",
        "source": "shopify",
        "match_type": match_type,
        "confidence": 0.88 if match_type == "exact" else 0.7,
        "reason": "Visual compare against the video chip." if match_type == "exact" else "Similar silhouette.",
    }
    if visual is not None:
        row["visual_score"] = visual
        row["visual_label"] = "same_item" if visual >= 0.82 else "similar"
    return row


def _result(
    case_id: str,
    items: list[dict[str, Any]],
    summary: str = "",
    *,
    empty_reason: str | None = None,
    keyframes: list[str] | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "job_id": case_id,
        "status": "done",
        "origin": "app",
        "media_type": "video",
        "outfit_summary": summary,
        "items": items,
        "keyframes": keyframes or (["data:image/jpeg;base64,AAA"] if items or empty_reason == "see" else []),
        "steps": [
            {"status": "ingesting", "at": "2026-09-20T00:00:00Z", "note": "pulling clear frames"},
            {"status": "done", "at": "2026-09-20T00:00:12Z"},
        ],
    }
    if empty_reason:
        payload["empty_reason"] = empty_reason
    if empty_reason != "ingest":
        payload["steps"].insert(1, {"status": "seeing", "at": "2026-09-20T00:00:04Z", "note": "reading the outfit across frames"})
    return payload


def _three(build) -> list[dict[str, Any]]:
    return [build() for _ in range(3)]


def recorded_video_runs() -> dict[str, list[dict[str, Any]]]:
    jacket = _garment(
        "jacket-00-04-02-16-14",
        "jacket",
        "black leather jacket silver zip",
        "black leather jacket silver zip",
        queries=["black leather jacket silver zip", "silver zip hardware bomber"],
        source_frame_index=1,
    )
    hoodie = _garment(
        "shirt-01-06-04-14-18",
        "shirt",
        "navy hoodie with readable logo",
        "navy hoodie chest logo",
        queries=["navy hoodie", "navy hoodie chest logo"],
        brand_cues=["logo text on chest"],
        source_frame_index=2,
    )
    tee = _garment(
        "shirt-02-08-05-12-14",
        "shirt",
        "plain white cotton t-shirt",
        "white cotton t-shirt",
        queries=["white cotton t-shirt"],
    )
    overlay_shirt = _garment(
        "shirt-03-03-02-11-15",
        "shirt",
        "grey waffle knit under tiktok ui",
        "grey waffle knit shirt",
        queries=["grey waffle knit shirt", "heather grey knit top"],
        source_frame_index=2,
    )
    overlay_pants = _garment(
        "pants-03-06-04-14-18",
        "pants",
        "dark wide-leg jeans",
        "dark wide leg jeans",
        queries=["dark wide leg jeans"],
        source_frame_index=2,
    )
    oxford_shirt = _garment(
        "shirt-06-08-05-12-14",
        "shirt",
        "white oxford button-down",
        "white oxford shirt",
        queries=["white oxford shirt", "white button down shirt"],
        source_frame_index=1,
    )
    oxford_pants = _garment(
        "pants-06-10-06-16-20",
        "pants",
        "light wide-leg jeans",
        "light wash wide jeans",
        queries=["light wash wide jeans"],
        source_frame_index=1,
    )

    return {
        "turning-leather-jacket": _three(
            lambda: _result(
                "turning-leather-jacket",
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
                "turning black leather jacket",
                keyframes=["data:image/jpeg;base64,FR0", "data:image/jpeg;base64,FR1", "data:image/jpeg;base64,FR2"],
            )
        ),
        "logo-hoodie-turning": _three(
            lambda: _result(
                "logo-hoodie-turning",
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
                "navy hoodie turning",
                keyframes=["data:image/jpeg;base64,H0", "data:image/jpeg;base64,H1"],
            )
        ),
        "generic-tee-clip": _three(
            lambda: _result(
                "generic-tee-clip",
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
                "plain white tee in a clip",
            )
        ),
        "dark-blur-fail": _three(
            lambda: _result(
                "dark-blur-fail",
                [],
                "Couldn't find a clear enough view of the outfit in this clip.",
                empty_reason="ingest",
            )
        ),
        "ui-overlay-tiktok": _three(
            lambda: _result(
                "ui-overlay-tiktok",
                [
                    {
                        "garment": overlay_shirt,
                        "matches": [
                            _match(
                                "Grey Waffle Knit",
                                "https://shop.example/knit",
                                match_type="similar",
                                visual=0.7,
                            )
                        ],
                    },
                    {
                        "garment": overlay_pants,
                        "matches": [
                            _match(
                                "Dark Wide Jeans",
                                "https://shop.example/jeans",
                                match_type="similar",
                                visual=0.66,
                            )
                        ],
                    },
                ],
                "grey knit and jeans under tiktok chrome",
            )
        ),
        "white-oxford-turning": _three(
            lambda: _result(
                "white-oxford-turning",
                [
                    {
                        "garment": oxford_shirt,
                        "matches": [
                            _match(
                                "White Oxford",
                                "https://shop.example/oxford",
                                match_type="similar",
                                visual=0.61,
                            )
                        ],
                    },
                    {
                        "garment": oxford_pants,
                        "matches": [
                            _match(
                                "Light Wide Jeans",
                                "https://shop.example/wide-jeans",
                                match_type="similar",
                                visual=0.58,
                            )
                        ],
                    },
                ],
                "white oxford turning on sidewalk",
            )
        ),
        "empty-room-clip": _three(
            lambda: _result(
                "empty-room-clip",
                [],
                "dark room, no readable clothes",
                empty_reason="see",
                keyframes=["data:image/jpeg;base64,ROOM"],
            )
        ),
    }
