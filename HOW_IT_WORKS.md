# How Fit Stealer works today

This is a walkthrough of what is actually built, in the order a user experiences it.

**Fit Stealer** is a phone app: you give it a picture of an outfit, it finds the clothes, and it returns shop links. Clothing is the first use case. The long-term idea is “Shazam for whatever is on screen.”

**What is live (two branches, not fully merged yet):**

- **Screenshot matching agent** is on this checkout (`matching-optimization` / local `develop`): chip-first See, VisualJudge, Shopify fan-out, retries. The Expo picker here is still **images only**.
- **Short video** is on **`origin/develop`** (teammates: commits like `e4aa66b` / `b286db3` “video support”, `345f8ae` “better video handling”). That path is functional: pick/record a ≤15s clip → keyframes → VLM → the **older** Shopify + title ranker. It does **not** use the matching agent.

---

## The pieces (who does what)

There are four runtimes. The phone never talks to AI vendors directly.

| Piece | Where | Job |
| --- | --- | --- |
| Phone app | `frontend/` (Expo) | Pick a screenshot, show a loading screen, poll for results, render FitCards |
| Product API | `backend/` Express on port 4000 | Accept the upload, own the job, call tools, save the result |
| Tool server | `ai-service/` FastAPI on port 8000 | Vision, crops, catalogs, visual compare, ranking — one tool per step |
| Optional brain | `agent/` Cloudflare Worker | Same matching loop as Express, with a Durable Object per job and KV cache |

On your laptop, the Expo app talks to Express. Express talks to FastAPI. FastAPI talks to Baseten, Shopify, OpenAI, Composio, and Browserbase.

A job is a record with a `job_id` and a status the app polls: `queued → ingesting → seeing → detailing → sourcing → judging → (retrying) → ranking → done`.

---

## How matching optimization changed the architecture

**Before (the old MVP):** one screenshot went through one vision call on the whole photo, one Shopify search of 5 products, then an OpenAI ranker that only read titles. Same screenshot could return different clothes and different links every time. “Exact” was almost never honest, because nothing compared the garment photo to the product photo.

**After (the matching agent):** Capture and the job contract stayed the same (`POST /api/identify` + poll). See / Source / Rank became a loop of tools:

1. Hash the image and return a cached result if we already ran this photo.
2. Look at the **scene** (find each garment and draw a box).
3. Crop each box into a **chip** (a close-up of one item, with padding).
4. Look at the **chip** again (color, hardware, logo, better search queries).
5. Search **several catalogs in parallel** (Shopify 2–3 ways, Composio if Shopify is thin).
6. **Visually compare** the chip to product photos.
7. If the match is only “okay,” try a sharper query. If it is weak, open the web with a browser agent, then compare again.
8. OpenAI writes the user-facing cards. Code then **blocks fake exacts**: “Found” only if vision said same item, score ≥ 0.82, and the category agrees.

The app still uploads one image and still shows cards. Everything between ingest and return is now an agent with memory (cache), tools, and retries.

---

## How each sponsor is used

These are the prize tracks from `sponsors.md`, mapped to real steps — not SDKs sitting unused.

| Sponsor | Where it sits | What it actually does |
| --- | --- | --- |
| **Expo** | Capture + Return | React Native app: photo library / camera, scanning UI, job screen, FitCards, haptics. |
| **Baseten** | Eyes | Three vision jobs: scene detect, chip close-up, visual judge (chip vs product photos). Temperature 0, seed 0. |
| **OpenAI** | Claims | Merge chip details into search queries. Rank cards. Structured “exact vs similar.” Never invent a brand. Codex is the build teammate story, not a runtime. |
| **Shopify** | Commerce | Global Catalog: text search plus optional `like` on the chip image. Up to 10 hits per query, 2–3 queries per garment. |
| **Composio** | Extra catalog | `SEARCH_SHOPPING` when Shopify returns fewer than 4 unique URLs (or if forced on). No OAuth. Same honesty gate as Shopify. |
| **Browserbase** | Web fallback | Only when visual scores are weak (`< 0.62`) or there are no catalog hits. Reverse-image + shopping pages, 15s cap. Not on every screenshot. |
| **Sentry** | Observability | Errors + tracing + logs (and Replay on the app). Logs image hash, queries, visual score. If nothing is exact, names the miss: SeeChip, retrieve, judge, or rank. |
| **Cloudflare** | Agent brain | Worker + Durable Object per job + KV cache of results. Same loop as Express. The phone still uses Express `:4000` unless you point it at the Worker. |
| **Cognition / Devin** | Build | Prize for the session that produced the matching work — not a step in the live pipeline. |

Honesty rules that never change: brand is blank unless a logo/tag was actually readable. Titles rhyming is not “exact.” Fake shop URLs are not shown when search fails.

---

## Section 1 — Screenshot / photo upload (the live product)

This is the path a judge uses.

### Step 1 — Capture (Expo)

1. Open Fit Stealer.
2. Choose a photo from the library or take one with the camera (`expo-image-picker`). Videos are not offered.
3. The app uploads multipart form data to `POST /api/identify`: the image, `type=image`, `origin=app`, and a device id (for recent searches).
4. Express returns a `job_id` immediately. The UI shows the scanning circle and starts polling `GET /jobs/:id` every 400ms.

### Step 2 — Ingest (Express)

1. Reject non-images and files over 45 MB.
2. Downscale the JPEG (long edge ~1280px).
3. Compute **sha256** and a perceptual hash (pHash).
4. If this exact (or near-duplicate) image already finished a **live** job, return that result instantly. Mock results are never cached.

Status: `ingesting`.

### Step 3 — See the scene (Baseten)

1. Express calls the AI service with `detail=0` so this first pass is scene-only.
2. Baseten looks at the **whole screenshot** and lists garments: category, rough description, bounding box, confidence, outfit one-liner.
3. OpenAI structured output cleans that list (drop junk, do not invent brand).
4. PIL crops each box with **~10% padding**. Crops that cover ≥ 85% of the frame (the whole person) are skipped; that garment still goes to text search without a chip.
5. Garment ids are stable (`category` + quantized box), not random UUIDs.

Status: `seeing`. Items with confidence below 0.5 are dropped. If nothing remains, the job ends with an honest empty state: we could not see a clear outfit.

### Step 4 — See the chip (Baseten + OpenAI)

Status: `detailing`. The UI can already show garment names with empty matches.

1. Each padded crop is sent alone to Baseten (`POST /tools/see-chip`).
2. This pass overwrites description, attributes, and `brand_cues` (zippers, wash, readable logo text).
3. OpenAI merges that into up to three search queries: primary, distinctive, brand-if-any. `search_query` is the primary, canonicalized (lowercase, color aliases, filler words removed).
4. If SeeChip fails, the job keeps the scene description and continues.

This is the biggest perception change vs the old pipeline: search is driven by the **isolated garment**, not the TikTok frame.

### Step 5 — Source (Shopify + maybe Composio)

Status: `sourcing`. Per garment, in parallel, 20 second budget:

1. **Primary** Shopify text search.
2. **Distinctive** Shopify text search (hardware / wash / cut).
3. **Like** Shopify search: short query plus the chip image, if a chip exists.

Hits are deduped by URL (tracking params stripped). Shopify wins if Composio later returns the same link. Products with photos are sorted first so the judge has pixels.

**Composio** runs only if Shopify is thin (< 4 unique URLs) unless `COMPOSIO_SHOPPING=always`. Missing API key = skip.

If catalog tools are completely down, the job errors (or uses mock cards only when `IDENTIFY_MOCK` is set). Live jobs do not invent Shopify URLs.

### Step 6 — Visual judge (Baseten)

Status: `judging`.

1. Fetch up to 8 product images (skip broken URLs, skip private/localhost hosts).
2. One vision call: chip + those photos.
3. Each product gets a score 0–1 and a label: `same_item`, `similar`, or `different`.

This is what unlocks honest “Found.” The old ranker never saw product photos.

### Step 7 — Retry if needed (matching loop)

The loop lives in Express (`matchingLoop.js`). Cloudflare IdentifyAgent mirrors the same rules.

- Visual **≥ 0.82** → good enough. Skip the browser.
- Visual **0.62–0.81** → status `retrying`: rotate to the distinctive query, search again, re-judge.
- Visual **< 0.62**, no scores, or no hits → status `retrying`: **Browserbase** reverse-image (Bing Visual Search, Lens fallback, then Google Shopping / Grailed). 15 seconds, 1–2 pages. Merge listings (`source: browserbase`), then **re-judge**.

Browserbase is a specialist, not a default. `BROWSERBASE=off` or a missing key just keeps catalog results.

### Step 8 — Rank and honesty (OpenAI + local gate)

Status: `ranking`.

1. OpenAI picks up to 3 candidates and writes a one-line reason.
2. Code then demotes fakes:
   - `exact` only if visual score ≥ 0.82 **and** label is `same_item` **and** the title matches the garment category.
   - A high score with label `similar` stays Similar.
   - If vision failed, fallback ranking is similar-only.
3. If any card is exact, the UI shows **that one card only** (one strong Found beats three weaks). Otherwise up to 3 Similar cards.
4. Chip file paths are stripped before the JSON is saved.

### Step 9 — Return (Expo)

1. Job status `done`. Result is cached by image hash.
2. Sentry logs garment count, shop hits, visual score; if exact count is 0, it names the failed stage.
3. Recent searches are stored per device (Mongo when configured).
4. The app navigates to the job screen: outfit summary, FitCards with Found / Similar, tap opens the product URL.
5. Temp crops are deleted.

**Statuses the user can see:** queued, ingesting, seeing, detailing, sourcing, judging, retrying, ranking, done, error.

---

## Section 2 — Short video upload (functional on `origin/develop`, not matching-optimized)

This is **Stage 3 ingest + the old Source/Rank**. Same job (`POST /api/identify`, poll `GET /jobs/:id`). Only capture and See change. After garments exist, it uses `sourceAndRank` — one Shopify query + title ranker — not SeeChip / VisualJudge / Browserbase-on-weak.

Needs **ffmpeg/ffprobe** on the machine. Caps: **15 seconds**, **50 MB** at the AI service (Express upload limit is 45 MB), formats `.mp4` `.mov` `.webm` `.avi` `.mkv` `.m4v`. Perception timeout is 90s (`VIDEO_TIMEOUT_MS`).

### Step 1 — Capture (Expo on `origin/develop`)

1. Library picker allows **images and videos** (`videoMaxDuration: 15`). Long-press camera does the same.
2. `lib/api.ts` looks at mime/extension. Video goes in multipart field `video` with `type=video`. Photos still use field `image`.
3. Same `POST /api/identify`. Scanning copy switches to “Analyzing video frames.”
4. Polling is unchanged.

On **this local checkout**, the picker is still `mediaTypes: ['images']` and Express still returns 400 for non-images — pull `origin/develop` (or merge) to use the clip path.

### Step 2 — API accepts the clip (Express)

1. Multer reads fields `image`, `video`, or `file`.
2. `isVideoUpload` (mp4 / quicktime / webm / m4v / mkv) or `type=video`.
3. Job starts with `mediaType: 'video'`. No JPEG downscale / pHash cache (that is screenshot-only on the matching branch).

Status: `ingesting`, then immediately `seeing`.

### Step 3 — Ingest: turn the clip into a few stills (`video_processor.py`)

Express calls FastAPI `POST /api/identify-video` (`perceiveVideo`). Combined ingest + crop. There is also `POST /tools/ingest` (frames + VLM, no chips).

**Tier 1 — local, cheap (ffmpeg + PIL):**

1. **Validate** with ffprobe: duration 0.5–15s, size, codec.
2. **Sample** at 4 fps as JPEGs.
3. **Downscale** longest edge to 768px, then score sharpness (edge variance) and brightness.
4. **Drop** blurry / near-black / near-white frames. If none survive, the job finishes empty: “Couldn't find a clear enough view of the outfit in this clip.” No junk frames are sent to the VLM.
5. **Coverage windows:** split the clip into up to 5 equal time buckets; keep the sharpest *passing* frame per bucket so picks are spread out, not clustered on one sharp second.

**Tier 1.5 — cheap Baseten pass (only if more than 3 candidates):**

`select_best_video_frames` (low image detail) ranks which frames show the **outfit** best (facing camera, unobstructed, not UI overlay). Keep at most **3**. If this call fails, it keeps the first 3 vetted frames.

### Step 4 — See across frames (Baseten)

**Tier 2 — expensive VLM:** `analyze_frames_with_vlm` with a **video** system prompt (temperature 0.1, not the matching-agent `0`/`seed=0`).

1. Each kept frame is labeled `[Frame N @ Xs]` using the **original candidate index** (so later crops hit the right file).
2. Model lists garments across frames and **merges duplicates**. `bbox` is relative to `source_frame_index`.
3. Same honesty: `brand` null unless a logo is readable.
4. FastAPI crops each garment from **that source frame** (not the full clip). Chips get `chip_key`. Keyframe JPEGs are returned as data-URLs for the job thumbnail.

Status stays `seeing` until garments are back. Confidence &lt; 0.5 dropped. Empty list → done, no shop search.

### Step 5 — Source and rank (old loop, not Section 1)

Status: `sourcing`, then `ranking`.

On `origin/develop` Express still:

1. Logs “Shopify yes · Browserbase skipped · Composio skipped.”
2. Per garment, **`sourceAndRank`** (combined tool): typically **one** catalog query + OpenAI rank from **titles**, not VisualJudge.
3. If live search returns nothing, it can fall back to **mock** shop cards (the matching-agent branch stopped doing that).

No detailing / judging / retrying statuses. No chip re-analysis. No product-photo compare. No Browserbase reverse-image when Shopify misses.

### Step 6 — Return

Same FitCards. Job may include `keyframes` and `thumbnail_url` from the first/best frame. Temp video file is deleted after identify-video returns.

### Why this is “not optimized like screenshot”

| | Screenshot matching agent (Section 1) | Video on `origin/develop` |
| --- | --- | --- |
| Ingest | Downscale + hash + cache | ffmpeg → sharpness windows → 3 frames |
| See | Scene, then **SeeChip** per crop | Multi-frame VLM merge, **one** pass |
| Source | 2–3 Shopify queries + Composio if thin | One Shopify path |
| Exact | VisualJudge + score gate ≥ 0.82 | Title ranker |
| Retry | Reformulate, then Browserbase if weak | None |
| Determinism | temperature 0, seed 0, stable ids | temperature 0.1, uuid garment ids |

Video **is** a real upload path once you have `origin/develop` + ffmpeg + Baseten. It is still the pre-agent identifier: extra work is **which stills** to look at, not how products are judged. The intended merge is: clip → these keyframes → **then** the Section 1 matching loop.

---

## What is not in the live demo

- **Stage 2 Android overlay** (pause TikTok → tap a bubble) — designed, not shipped. Same API, new capture client.
- **iOS overlay over other apps** — not possible; share sheet is the fallback and is not the Stage 1 path.
- **URL paste / TikTok download** — old stub (`/api/process-url`); not the product.
- **Stage 4 any-category / accessibility** — `accessibility_line` and `outfit_summary` exist as seeds; the identifier is still clothing-only.

---

## Mental model in one paragraph

You upload a screenshot. Express hashes it (repeat uploads skip work). Baseten finds clothes in the scene, we crop each one, Baseten looks at the crop, Shopify (and maybe Composio) searches with those queries and the crop image, Baseten compares the crop to product photos, we only browse the open web when that compare is weak, OpenAI writes the cards, code forbids fake “exact,” Expo shows Found/Similar.

On `origin/develop`, a short clip instead becomes a handful of clear frames, Baseten merges clothes across those frames, chips are cut from the best frame, then the **old** Shopify + title ranker fills the same cards. Those two halves are not merged in one checkout yet.
