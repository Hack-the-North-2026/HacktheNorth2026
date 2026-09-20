# How Fit Stealer works today

This is a walkthrough of what is actually built, in the order a user experiences it.

**Fit Stealer** is a phone app: you give it a picture of an outfit, it finds the clothes, and it returns shop links. Clothing is the first use case. The long-term idea is “Shazam for whatever is on screen.”

**What is live:** one identify job for both media types. A screenshot or a ≤15s clip goes through the same matching agent (SeeChip → retrieve → VisualJudge → retry / Browserbase-if-weak → honesty rank). Video adds ffmpeg keyframe ingest, a clip-hash cache, and a scan UI that shows the frames we used.

---

## The pieces (who does what)

There are four runtimes. The phone never talks to AI vendors directly.

| Piece | Where | Job |
| --- | --- | --- |
| Phone app | `frontend/` (Expo) | Pick a screenshot or ≤15s clip, show live status + keyframes, poll for results, render FitCards |
| Product API | `backend/` Express on port 4000 | Accept the upload, own the job, call tools, save the result |
| Tool server | `ai-service/` FastAPI on port 8000 | Vision, crops, catalogs, visual compare, ranking — one tool per step |
| Optional brain | `agent/` Cloudflare Worker | Same matching loop as Express, with a Durable Object per job, R2 media/frames, and KV cache keyed by image or clip sha256 |

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
2. Choose a photo or a ≤15s clip from the library, or long-press for the camera (`expo-image-picker`).
3. The app uploads multipart form data to `POST /api/identify`: field `image` + `type=image`, or field `video` + `type=video`, plus `origin=app` and a device id.
4. Express returns a `job_id` immediately. The UI shows the scanning circle and starts polling `GET /jobs/:id` every 400ms.

### Step 2 — Ingest (Express)

1. Reject files that are neither images nor short clips, and files over 45 MB.
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

## Section 2 — Short video (same matching agent, different ingest)

A clip is a **new ingest**, not a second product. Same job (`POST /api/identify`, poll `GET /jobs/:id`). ffmpeg picks stills; then the Section 1 loop runs on those chips.

Needs **ffmpeg/ffprobe**. Caps: **15 seconds**, **50 MB** at the AI service (Express upload limit is 45 MB), formats `.mp4` `.mov` `.webm` `.m4v` `.mkv`. Ingest is ffmpeg-only (~30s). Visibility pick + multi-frame See share a 90s budget (`VIDEO_SEE_TIMEOUT_MS`). Combined ingest+see fallback is 90s (`VIDEO_TIMEOUT_MS`). Expo poll deadline is **270s** (`JOB_TIMEOUT_MS`).

### Step 1 — Capture (Expo)

1. Library picker allows **images and videos** (`videoMaxDuration: 15`). Long-press camera does the same.
2. `lib/api.ts` sends multipart field `video` with `type=video`. Photos still use field `image`.
3. Scan title is “Analyzing video frames.” The subtitle follows **live** job status (`Pulling clear frames…` → SeeChip → shops → judge → maybe retry).
4. As soon as ingest publishes `keyframes`, `ScanningCircle` flips through them.

### Step 2 — API accepts the clip (Express or Cloudflare)

1. Multer (or the Worker) reads fields `image`, `video`, or `file`.
2. `isVideoUpload` or `type=video` sets `media_type: video`.
3. sha256 of the **clip bytes** is the cache key (never pHash an MP4). Repeat uploads skip ffmpeg. Mock jobs are not cached.

Status: `ingesting`.

### Step 3 — Ingest: turn the clip into a few stills

Express calls `POST /tools/ingest` (ffmpeg + visibility pick). Keyframes are written onto the job **before** See so the UI can breathe.

**Tier 1 — local, cheap (ffmpeg + PIL):**

1. **Validate** with ffprobe: duration 0.5–15s, size, codec.
2. **Sample** at 4 fps as JPEGs.
3. **Downscale** longest edge to 768px, then score sharpness and brightness.
4. **Drop** blurry / near-black / near-white frames. If none survive, the job finishes empty: `empty_reason: ingest` — “No frame in this clip was clear enough.” Sentry `identify.exact_rate_zero` names `fail_stage=ingest`.
5. **Coverage windows:** up to 5 time buckets; keep the sharpest passing frame per bucket.

**Tier 1.5 — cheap Baseten pass during See (only if more than 3 candidates):**

`select_best_video_frames` (low image detail, `temperature=0` `seed=0`) keeps at most **3** outfit-readable frames. This runs in `seeing`, not inside the ffmpeg ingest budget.

On Cloudflare, the clip and those JPEG frames are stored in **R2**. KV still keys the finished result by clip sha256.

### Step 4 — See across frames, then crop the right pixels

Status: `seeing`. `POST /tools/see` with `image_paths` + `frame_metadata`.

1. Baseten merges garments across frames (`temperature=0` `seed=0`). `bbox` is relative to `source_frame_index`.
2. PIL crops that source frame with 10% pad; whole-person boxes (≥85% coverage) skip the chip and go to text search.
3. A second usable angle becomes `alt_chip_key`. SeeChip and VisualJudge use the sharper chip.
4. Confidence &lt; 0.5 dropped. Frames but no clothes → `empty_reason: see` — “We couldn’t see a clear outfit.”

### Step 5 — Same matching loop as Section 1

Status: `detailing` → `sourcing` → `judging` → (`retrying`) → `ranking`.

`matchOutfit` is **not** forked. Video chips hit Shopify `like`, Composio only when the catalog is thin, Browserbase only when visual &lt; 0.62, and `exact` still needs visual ≥ 0.82 + `same_item` + category agree. Clips hit Browserbase more often; that is the intended Stage 3 story, not “browse every clip.”

### Step 6 — Return

Same FitCards. Hero is the first keyframe; a **FRAMES WE USED** strip appears when there are several. Strong exact still wins over three weaks. Temp clip/work-dir files are deleted; persisted chips stay under `fit-stealer-chips` until cleanup.

| | Screenshot | Video |
| --- | --- | --- |
| Ingest | Downscale + sha256/pHash cache | ffmpeg → sharpness windows → ≤3 frames; sha256 of bytes |
| See | Scene, then SeeChip per crop | Multi-frame merge, crop from `source_frame_index`, then SeeChip |
| Source / exact / retry | Shared `matchOutfit` | Shared `matchOutfit` |
| Empty | “We couldn’t see a clear outfit in this photo.” | Ingest miss vs See miss (different copy) |
| Memory | KV / local hash | Same, clip sha256; Worker also stores frames in R2 |

---

## What is not in the live demo

- **Stage 2 Android overlay** (pause TikTok → tap a bubble) — designed, not shipped. Same API, new capture client.
- **iOS overlay over other apps** — not possible; share sheet is the fallback and is not the Stage 1 path.
- **URL paste / TikTok download** — old stub (`/api/process-url`); not the product.
- **Stage 4 any-category / accessibility** — `accessibility_line` and `outfit_summary` exist as seeds; the identifier is still clothing-only.

---

## Mental model in one paragraph

You upload a screenshot or a short clip. Express (or the Cloudflare IdentifyAgent) hashes it so repeats skip work. A clip is turned into a few clear frames first. Baseten finds clothes, we crop each one from the right frame, Baseten looks at the crop, Shopify (and maybe Composio) searches with those queries and the crop image, Baseten compares the crop to product photos, we only browse the open web when that compare is weak, OpenAI writes the cards, code forbids fake “exact,” Expo shows Found/Similar and — on video — the frames we actually used.
