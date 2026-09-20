# Video golden clips

Recorded fixtures in `recorded.py` test the scorer (no Baseten, no ffmpeg).

Recorded fixtures prove the scorer, not live accuracy. Live `--live --videos` posts whichever clips are on disk three times each and skips the rest.

Clips in this folder (gitignored):

| File | Case | What it is |
| --- | --- | --- |
| `ui-overlay-tiktok.mov` | `ui-overlay-tiktok` | 5.4s TikTok: grey waffle knit, dark wide jeans, white sneakers, `@bygeorgemem` chrome |
| `white-oxford-turning.mp4` | `white-oxford-turning` | 12.7s sidewalk turn: white oxford, light wide jeans, black shoes |

Planned kinds still without files: `turning-leather-jacket`, `logo-hoodie-turning`, `generic-tee-clip`, `dark-blur-fail`, `empty-room-clip`. Drop `{case_id}.mp4` or `.mov` when you have them.

```
python -m evals.run_golden --live --videos
```

Each present clip is posted three times. Jaccard(garments) must be 1 and the top URL must stay put (or the case is an honest empty). Cache-hits on runs 2–3 of the same bytes are expected after a successful first run.
