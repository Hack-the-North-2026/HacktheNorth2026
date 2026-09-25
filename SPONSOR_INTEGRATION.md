# How prize-track sponsors are incorporated

Fit Stealer is a matching agent: a screenshot or short clip goes in, garment chips come out, catalogs are searched, product photos are judged, and the phone shows honest Found / Similar cards. Each track in [sponsors.md](./sponsors.md) occupies a real step in that loop — not an unused SDK.

The phone never talks to vendors. Expo talks to Express (`:4000`). Express talks to the FastAPI tool server (`:8000`). FastAPI talks to Baseten, Shopify, OpenAI, Composio, and Browserbase. Cloudflare can own the same loop as a Worker.

```text
Capture (Expo)
    → Ingest
    → See (Baseten) + schema (OpenAI)
    → Source (Shopify, maybe Composio)
    → Judge (Baseten)
    → Retry if weak (Browserbase)
    → Rank (OpenAI + local honesty gate)
    → Return (Expo)
         ↘ errors / traces / logs / replay (Sentry)
         ↘ optional brain: Worker + Durable Object + KV + R2 (Cloudflare)
```

Codex and Devin are how the pipeline was built, not steps a live job calls.

---

## Composio — extra catalog when Shopify is thin

**Prize:** most creative, useful agent use of Composio.

**Where:** `ai-service/services/composio_shopping.py`, called from retrieval (`/tools/retrieve`).

The agent shops with one allowlisted tool: `COMPOSIO_SEARCH_SHOPPING`. No OAuth, no Tool Router over 1,000 apps. It runs only when Shopify returns fewer than 4 unique URLs (or `COMPOSIO_SHOPPING=always`). Hits keep `source: composio` and go through the same VisualJudge + honesty gate as Shopify. A missing key is a no-op.

---

## OpenAI — claims, not the eyes

**Prize:** what you built with the API, and how Codex helped you build it.

**Where:** Structured Outputs in `baseten_vlm.py` / `see_chip.py`, ranker in `product_ranker.py`.

Baseten looks at pixels. OpenAI decides what we are allowed to say:

- Clean the garment list (drop junk, never invent a brand).
- Merge chip details into 2–3 search queries.
- Pick up to 3 candidates and write the one-line reason on each card.

Code then blocks fake exacts: Found only if vision said `same_item`, score ≥ 0.82, and the category agrees. Codex is the build teammate (schemas, loop, honesty gate), not a runtime.

---

## Shopify — primary commerce search

**Prize:** AI × commerce that helps merchants or shoppers.

**Where:** `ai-service/services/shopify_filter.py` → Shopify Global Catalog (`catalog.shopify.com` UCP), not one demo store.

Per garment, 2–3 searches in parallel (20s budget):

1. Primary text query from the chip.
2. Distinctive query (hardware / wash / cut).
3. `like` — short query plus the chip image, if a crop exists.

Hits are deduped by URL. Shopify wins if Composio later returns the same link. Products with photos are sorted first so the judge has pixels. Live jobs never invent Shopify URLs.

---

## Baseten — the eyes

**Prize:** best use of Baseten inference.

**Where:** `baseten_vlm.py` (scene), `see_chip.py` (close-up), `visual_judge.py` (chip vs product photos). Hosted Model APIs (`inference.baseten.co`), `temperature=0` `seed=0`.

Three vision jobs, not one:

1. **Scene** — find each garment and its box on the still (or merged video frames).
2. **SeeChip** — look at the padded crop alone: color, hardware, readable logo text.
3. **VisualJudge** — compare that crop to up to 8 product photos; score 0–1 and label `same_item` / `similar` / `different`.

That last call is what makes “Found” honest. Video adds a cheap frame-pick pass when there are more than 3 candidate stills.

---

## Browserbase — web fallback, not the default

**Prize:** best use of Browserbase.

**Where:** `ai-service/services/browserbase_scraper.py` (`/tools/browse`).

A cloud browser session runs only when VisualJudge is weak (`< 0.62`), there are no scores, or catalogs returned nothing. Mid-band scores (0.62–0.81) reformulate the query first. Visual ≥ 0.82 skips the browser.

15 second cap, 1–2 pages: reverse-image the chip (Bing Visual Search, Lens fallback), then Google Shopping / Grailed. Listings keep `source: browserbase` and are judged again. `BROWSERBASE=off` or a missing key leaves catalog results standing.

---

## Expo — the product the judge holds

**Prize:** best mobile experience built with Expo.

**Where:** `frontend/` — Expo Router, React Native.

This is the capture and return surface, not a web wrapper:

- `expo-image-picker` for a screenshot or ≤15s clip (camera roll or long-press camera).
- Expo Router: home → scanning → `job/[id]` FitCards.
- `expo-video` for clip preview and the “frames we used” strip.
- `expo-haptics` on first result.
- Live job status while the agent runs (`queued` → `seeing` → `sourcing` → …).

Stage 2 (not the demo path) would add a native Android overlay on the same SDK; iOS overlay over other apps is an OS limit.

---

## Sentry — observability that changes the product

**Prize:** at least two products beyond error monitoring, and data that shaped the build.

**Where:** `@sentry/react-native` in the app, `@sentry/node` on Express, `sentry-sdk` on FastAPI.

Beyond errors:

- **Tracing** — one `identify` span across upload → See → retrieve → judge → rank.
- **Logs** — `job_id`, image/clip hash, search queries, `visual_score`, garment count, shop hits.
- **Session Replay** on the Expo app (pick → scan → cards).
- If nothing is exact, `identify.exact_rate_zero` names the miss: ingest, SeeChip, retrieve, judge, or rank.

That miss stage is why retries, thresholds, and empty-state copy exist. Raw pixels are not logged.

---

## Cloudflare — the agent’s backend brain

**Prize:** an agent with memory, tools, state, and real work, powered by Workers. Pages alone does not qualify.

**Where:** `agent/` — Workers + Agents SDK.

`IdentifyAgent` is a Durable Object per `job_id`. It runs the same matching loop as Express (see → detail → retrieve → judge → maybe browse → rank), with:

- **Workers** — HTTP contract (`POST /api/identify`, poll `/jobs/:id`).
- **Durable Objects** — job memory and step log.
- **R2** — uploaded media and video keyframe JPEGs.
- **KV** — finished result keyed by image or clip sha256 (repeats skip tools).

The phone still uses Express unless you point it at the Worker. The contract is already Worker-shaped.

---

## Cognition / Devin — how the matching work was built

**Prize:** most interesting technical project built with Devin.

Devin is not a live pipeline step. The artifact is the matching agent itself: chip-first See, retrieval fan-out, VisualJudge honesty, Browserbase-only-when-weak, and the Cloudflare loop that mirrors Express.

---

## One-line map

| Sponsor | Pipeline step | In the repo |
| --- | --- | --- |
| **Expo** | Capture + Return | `frontend/` |
| **Baseten** | See, SeeChip, VisualJudge | `ai-service/services/baseten_vlm.py`, `see_chip.py`, `visual_judge.py` |
| **OpenAI** | Schema + queries + rank copy | `baseten_vlm.py`, `see_chip.py`, `product_ranker.py` |
| **Shopify** | Primary catalog | `shopify_filter.py` |
| **Composio** | Extra catalog if Shopify is thin | `composio_shopping.py` |
| **Browserbase** | Reverse-image when visual is weak | `browserbase_scraper.py` |
| **Sentry** | Errors + tracing + logs + Replay | `frontend/lib/sentry.ts`, `backend/src/sentry.js` |
| **Cloudflare** | Optional matching-agent brain | `agent/` |
| **Cognition / Codex** | Build | not a runtime |

Honesty that never changes: brand is blank unless a logo or tag was readable; titles rhyming is not exact; fake shop URLs are not shown when search fails.

For the full job walkthrough see [HOW_IT_WORKS.md](./HOW_IT_WORKS.md). For topology and contracts see [ARCHITECTURE.md](./ARCHITECTURE.md).
