# Matching quality

[OVERVIEW.md](./OVERVIEW.md) is the product north star. [ARCHITECTURE.md](./ARCHITECTURE.md) is topology. This file is how we make the identifier more accurate than a reverse-image dump.

Stage 1 capture is unchanged: Expo screenshot → `POST /api/identify`. Matching is a multi-pass agent. Later stages stack; they do not rewrite the job contract.

## Why Google Lens loses on clothes

Lens dumps web pages for the whole screenshot. Fashion screenshots usually match the TikTok frame or a vaguely similar outfit. We isolate the garment, search commerce catalogs, then visually judge product photos against the chip.

## Stages

| Stage | Status | Proof |
| --- | --- | --- |
| A Freeze the dice | **ship** | Same bytes (or pHash Hamming ≤ 2) return the cached result. VLM still uses `temperature=0` + `seed=0`. |
| B Chip-first See | **ship** | Chip descriptions overwrite scene copy; brand stays null without cues |
| C Visual Judge | **ship** | `exact` only if visual ≥ 0.82 **and** `visual_label=same_item` **and** category agrees |
| D Retrieval fan-out | **ship** | 2–3 Shopify queries + Composio (primary + distinctive when thin), URL dedup |
| E Browserbase reverse-image | **ship** | Weak visual `< 0.62` only; mid-band `0.62–0.81` reformulates first |
| F Matching agent brain | **ship** | Express loop is the product. Cloudflare DO mirrors merge/scrub/exact rules |
| G Eval + Sentry | **scorer + live** | Recorded fixtures test the scorer. `python -m evals.run_golden --live` is the accuracy run |

## Stage A — what landed

Determinism only. No new sponsors.

- Baseten See, SeeChip, and VisualJudge use `temperature=0` and `seed=0`. Ranker also sends `seed=0`. Garment ids are `category + quantized bbox` (20 bins). Chip files are `{garment_id}.jpg` (no uuid).
- `search_query` is canonicalized (lowercase, color aliases, filler dropped) in both the VLM post-process and the Express normalizer.
- Downscaled JPEG gets `sha256` + 8×8 average hash. Cache key is sha256; a pHash Hamming distance ≤ 2 is a near-duplicate hint only. Live jobs never cache mock matches.
- Cropper pads bboxes 10% and skips chips that cover ≥ 85% of the frame (whole-person boxes). The garment still goes to text search.
- Shopify Global Catalog `limit` is 10 (was 5).
- Sentry identify traces/logs include `image_hash`, `search_query`, and `visual_score: null` until Stage C.

## Stage B — what landed

Baseten now has two vision roles. Scene See still finds bboxes and `outfit_summary`. After crop, `POST /tools/see-chip` sends **only the padded chip** to Baseten and overwrites `description`, `attributes`, and `brand_cues`. OpenAI Structured Outputs merge those with the scene garment into `queries: [primary, distinctive, brand_if_any]` and `search_query` (primary). Source uses the chip query.

- Brand stays `null` unless the chip actually read a logo or tag (`brand_cues`).
- Chip failures fall back to the scene garment so the job still completes.
- Combined `/api/identify` still runs scene + crop + chip. Express `perceive` now uses `detail=0` (scene + crop only) so the job can show a **detailing** status, then calls `/tools/see-chip`. The see-then-crop fallback also hits `/tools/see-chip`.
- Garments carry `queries[]` for Stage D fan-out. Stage B still sends one Shopify query (the primary).

## Stage C — what landed

Rank is no longer titles-only. After Shopify returns candidates, VisualJudge fetches up to 8 product images (3.5s timeout, skip broken URLs) and sends **chip + product photos** to Baseten in one call. Each photo gets `score` 0–1 and `label` `same_item | similar | different`.

OpenAI still picks indexes and writes the user-facing reason. A local gate then enforces honesty:

- `exact` only if `visual_score >= 0.82`, `visual_label` is `same_item`, and the title agrees with the detected category. Empty titles cannot agree.
- Missing or weak visual scores cannot be promoted, even if titles rhyme. A `similar` label at 0.85 is still similar.
- If the vision call fails or no product image fetches, `fallback_rank_candidates` stays similar-only.
- VisualJudge keeps fetching product photos until it has 8 successes (broken CDNs are skipped, not padded with blanks).
- Product image fetches refuse localhost / private / link-local hosts.

Sentry `identify.done` now logs the best `visual_score` on the job. Matches carry `visual_score` / `visual_label` for Stage E (browse only when the best score is weak).

## Stage D — what landed

Source is no longer one Shopify query. Per garment, retrieval fans out **2–3 catalog searches in parallel** (asyncio, 20s budget):

1. **Primary** — chip `queries[0]` / `search_query`, text only.
2. **Distinctive** — hardware / wash / cut query from SeeChip, text only.
3. **Like** — padded chip + a short `color material category` query (only if a chip exists).

Hits are deduped by canonical URL (tracking params stripped). Shopify wins if Composio returns the same link. Candidates with product photos are sorted first so VisualJudge still sees pixels.

**Composio** `COMPOSIO_SEARCH_SHOPPING` runs only when Shopify is thin (< 4 unique URLs) or `COMPOSIO_SHOPPING=always`. It searches the primary and distinctive queries. No OAuth. Those rows keep `source: composio` and go through the same visual + honesty gate. Missing `COMPOSIO_API_KEY` is a no-op.

Express `SOURCE_TIMEOUT_MS` is 70s. `JOB_TIMEOUT_MS` is 210s so SeeChip + reformulate + optional browse can finish.

## Stage E — what landed

Browserbase runs **only when VisualJudge is weak** (best score `< 0.62`, no scores, or no catalog hits). Scores in `0.62–0.81` **reformulate** (distinctive query first) and re-judge before giving up. Visual ≥ 0.82 skips the browser.

Per garment, a Browserbase cloud session (15s cap, 1–2 pages):

1. Reverse-image the padded chip (Bing Visual Search, Google Lens fallback), waiting up to ~4.5s for results.
2. If that is thin, Google Shopping then Grailed using the chip query.
3. Stagehand `extract()` only when enough time remains; otherwise a DOM scrape.

Hits are `source: browserbase`. Catalog / Shopify URLs still win on dedup. VisualJudge **re-runs** on the merged set. Same honesty gate: `exact` still needs visual ≥ 0.82 and `same_item`.

`BROWSERBASE=off` disables it. Missing Playwright/key is a no-op so Shopify still stands.

## Stage F — what landed

Matching is an explicit loop. **Express is the Stage 1 product.** Cloudflare IdentifyAgent is the same loop with a Durable Object per `job_id`.

**Job states:** `seeing → detailing → sourcing → judging → (retrying) → ranking → done`

- **seeing** — Baseten scene + crop (`POST /api/identify?detail=0`)
- **detailing** — `POST /tools/see-chip` on each padded crop
- **sourcing** — `POST /tools/retrieve` (Shopify fan-out + Composio if thin)
- **judging** — `POST /tools/judge` (chip vs product photos)
- **retrying** — distinctive-query reformulate on mid-band visual; `POST /tools/browse` only when visual is weak (`< 0.62`); then re-judge
- **ranking** — `POST /tools/rank` (OpenAI honesty). Visual ≥ 0.82 skips Browserbase. Rank failures return empty matches, never mock shop cards.

Each status is appended to `IdentifyResult.steps`. Combined `/tools/source-rank` remains as a fallback.

**Cloudflare (`agent/`):** same merge order (catalog wins), `preferStrongExact`, and scrubbed `chip_key` paths in KV. Expo still hits Express `:4000`.

The FastAPI tool server binds `127.0.0.1` by default. Optional `TOOL_SERVER_SECRET` (`x-tool-key`) authenticates `/tools/*`. Chip paths must live under a `fit-stealer` temp dir.

## Stage G — what landed

A 10-case golden **scorer** lives in `ai-service/evals/golden/`. `python -m evals.run_golden` checks that the metrics code is stable on recorded fixtures. That is not a live top-1 proof.

Accuracy run: drop stills at `ai-service/evals/golden/images/{case_id}.jpg` and run `python -m evals.run_golden --live` against Express (three jobs per case). Jaccard and top URL must be stable.

When a job has **zero exact** cards, Sentry `identify.exact_rate_zero` names the miss: `seechip`, `retrieve`, `judge`, or `rank`.

UI still uses Found / Similar badges. If VisualJudge confirmed an exact, **only that card** is shown. Empty matches show “No product matches yet” instead of fake Shopify URLs.

Demo: `ai-service/evals/demo.sh path/to/screenshot.jpg`. Line for judges: *Lens showed similar outfits. We cropped the jacket, searched every Shopify merchant plus the open web, and confirmed the product photo against the chip.*

## Honesty rules that stay

Brand is null unless a logo or tag is readable. `exact` is not claimed from title overlap or a `similar` visual label. VisualJudge must see the chip and the product photo.
