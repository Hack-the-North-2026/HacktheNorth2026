# Matching quality

[OVERVIEW.md](./OVERVIEW.md) is the product north star. [ARCHITECTURE.md](./ARCHITECTURE.md) is topology. This file is how we make the identifier more accurate than a reverse-image dump.

Stage 1 capture is unchanged: Expo screenshot → `POST /api/identify`. Matching is a multi-pass agent. Later stages stack; they do not rewrite the job contract.

## Why Google Lens loses on clothes

Lens dumps web pages for the whole screenshot. Fashion screenshots usually match the TikTok frame or a vaguely similar outfit. We isolate the garment, search commerce catalogs, then visually judge product photos against the chip.

## Stages

| Stage | Status | Proof |
| --- | --- | --- |
| A Freeze the dice | **done** | Same screenshot × 3 → same garment ids, same `search_query`s, same top URLs |
| B Chip-first See | **done** | Chip descriptions more specific than the scene pass |
| C Visual Judge | **done** | `exact` only when the model saw chip + product photo |
| D Retrieval fan-out | **done** | 2–3 Shopify queries + Composio, URL dedup |
| E Browserbase reverse-image | planned | Weak visual scores only, then re-judge |
| F Matching agent brain | planned | Express loop, then Cloudflare DO + KV pHash cache |
| G Eval + Sentry | planned | Golden-set stability and top-1 |

## Stage A — what landed

Determinism only. No new sponsors.

- Baseten See and OpenAI ranker use `temperature=0`. Ranker also sends `seed=0`. Garment ids are `category + quantized bbox` (20 bins), never `uuid4`.
- `search_query` is canonicalized (lowercase, color aliases, filler dropped) in both the VLM post-process and the Express normalizer.
- Downscaled JPEG gets `sha256` + 8×8 average hash. In-memory map `sha256 → IdentifyResult` returns the previous cards on a repeat upload. Mock fallbacks are not cached.
- Cropper pads bboxes 10% and skips chips that cover ≥ 85% of the frame (whole-person boxes). The garment still goes to text search.
- Shopify Global Catalog `limit` is 10 (was 5).
- Sentry identify traces/logs include `image_hash`, `search_query`, and `visual_score: null` until Stage C.

## Stage B — what landed

Baseten now has two vision roles. Scene See still finds bboxes and `outfit_summary`. After crop, `POST /tools/see-chip` sends **only the padded chip** to Baseten and overwrites `description`, `attributes`, and `brand_cues`. OpenAI Structured Outputs merge those with the scene garment into `queries: [primary, distinctive, brand_if_any]` and `search_query` (primary). Source uses the chip query.

- Brand stays `null` unless the chip actually read a logo or tag (`brand_cues`).
- Chip failures fall back to the scene garment so the job still completes.
- Combined `/api/identify` (scene + crop + chip) is what Express `perceive` calls. The see-then-crop fallback also hits `/tools/see-chip`.
- Garments carry `queries[]` for Stage D fan-out. Stage B still sends one Shopify query (the primary).

## Stage C — what landed

Rank is no longer titles-only. After Shopify returns candidates, VisualJudge fetches up to 8 product images (3.5s timeout, skip broken URLs) and sends **chip + product photos** to Baseten in one call. Each photo gets `score` 0–1 and `label` `same_item | similar | different`.

OpenAI still picks indexes and writes the user-facing reason. A local gate then enforces honesty:

- `exact` only if `visual_score >= 0.82`, label is not `different`, and the title agrees with the detected category.
- Missing or weak visual scores cannot be promoted, even if titles rhyme.
- If the vision call fails or no product image fetches, `fallback_rank_candidates` stays similar-only.

Sentry `identify.done` now logs the best `visual_score` on the job. Matches carry `visual_score` / `visual_label` for Stage E (browse only when the best score is weak).

## Stage D — what landed

Source is no longer one Shopify query. Per garment, retrieval fans out **2–3 catalog searches in parallel** (asyncio, 20s budget):

1. **Primary** — chip `queries[0]` / `search_query`, text only.
2. **Distinctive** — hardware / wash / cut query from SeeChip, text only.
3. **Like** — padded chip + a short `color material category` query (only if a chip exists).

Hits are deduped by canonical URL (tracking params stripped). Shopify wins if Composio returns the same link. Candidates with product photos are sorted first so VisualJudge still sees pixels.

**Composio** `COMPOSIO_SEARCH_SHOPPING` runs only when Shopify is thin (< 4 unique URLs) or `COMPOSIO_SHOPPING=always`. No OAuth. Those rows keep `source: composio` and go through the same visual + honesty gate. Missing `COMPOSIO_API_KEY` is a no-op.

Express `SOURCE_TIMEOUT_MS` is 50s (retrieval 20s + judge + rank). `JOB_TIMEOUT_MS` is 120s.

## Honesty rules that stay

Brand is null unless a logo or tag is readable. `exact` is not claimed from title overlap. VisualJudge must see the chip and the product photo.
