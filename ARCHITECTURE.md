# Fit Stealer — Technical Architecture

This is the execution document. [OVERVIEW.md](./OVERVIEW.md) is the product north star (what, why, and in what order). This file is how we actually build it, on the repo we already have, with sponsors wired into real pipeline steps instead of bolted on at the end.

Product **stages** (1–4) are the roadmap. Pipeline **steps** (Capture → Return) are the job. Do not mix the words.

If a decision is not in this file, it is not in Stage 1.

---

## 1. What we are technically building

A **user-initiated identify job**.

The job does not change across the product. Capture, media type, and category do.

```text
Stage 1  in-app screenshot, clothing          ← hackathon ship line
Stage 2  Android overlay captures the frame
Stage 3  short video snippets, still clothing
Stage 4  any category (accessibility)
```

```text
Capture  →  Ingest  →  See  →  Source  →  Rank  →  Return
  client     bundle     VLM     tools     LLM      cards
```

| Product stage | Capture | Media | What See looks for |
| --- | --- | --- | --- |
| 1 | Expo image picker | One still | Clothes |
| 2 | Android overlay / tile (iOS fallback: last screenshot / share) | One still, taken from the paused frame | Clothes |
| 3 | Same surfaces + video picker / short user-initiated clip | Still **or** short video | Clothes, with more frames |
| 4 | Unchanged | Unchanged | Anything on screen |

Later stages add a client or a media decoder. They do not add a second identifier.

---

## 2. Constraints that decide the architecture

1. **Stage 1 is the only thing that must work this weekend.** Screenshot in, clothing cards out, inside the mobile app.
2. **Stage 2 is a new client of the Stage 1 API.** If the overlay has to talk to a different backend, we designed it wrong.
3. **Stage 3 is a new ingest, not a new product.** Video becomes frames (or a short native-video VLM call), then the same See → Source → Rank.
4. **Stage 4 generalizes the See schema and Source tools.** `Garment` becomes `DetectedItem` with `kind: clothing | …`. Clothing stays a mode.
5. **The app never calls models.** Expo and the Android overlay talk to the HTTP API. The API talks to Baseten, Shopify, and the rest. That is the whole reason Stage 2 is cheap.
6. **Honest matches.** Prefer “similar black leather jacket” over a confident wrong brand.
7. **Sponsors occupy a pipeline step, and they enter on a product stage.** Browserbase is not required to prove a screenshot of a jacket. It is required when stills are not enough.

---

## 3. System topology

Three runtimes. Capture clients plug into the same API.

```text
Stage 1 client                         Stage 2 client (later)
Expo app                               Android overlay / QS tile
image picker                           paused-frame screenshot
        \                             /
         \                           /
          ▼                         ▼
┌──────────────────────────────────────────────────────────┐
│  HTTP API  (Express shim → Cloudflare IdentifyAgent)     │
│  POST /jobs  { type: image | video }                     │
└───────────────┬────────────────────────────┬─────────────┘
                │                            │
                ▼                            ▼
┌───────────────────────────┐    ┌─────────────────────────┐
│  Perception  FastAPI      │    │  Cloud tools            │
│  image (S1) · frames (S3) │    │  Shopify Global Catalog │
│  Baseten VLM · PIL crops  │    │  Browserbase (S1 optional, S3+) │
│                           │    │  Composio               │
│                           │    │  OpenAI ranker          │
└───────────────────────────┘    └─────────────────────────┘
```

| Runtime | Path | Stage 1 job | Later |
| --- | --- | --- | --- |
| Mobile | `frontend/` | Pick screenshot, show FitCards | Android overlay module (Stage 2), video picker (Stage 3) |
| API | `backend/` then `agent/` | Accept image, run the loop | Same `/jobs` with `origin` + `type: video` |
| Perception | `ai-service/` | One image → VLM → chips | ffmpeg / keyframes / optional native video-in |

**Do not put the pipeline inside FastAPI as one giant `/api/process-url`.** That stub is URL-era. Stage 1 is `POST /api/identify` with an image. Perception exposes tools. The agent (or Express, until the Worker exists) owns the loop.

---

## 4. Product stages, technically

### Stage 1 — In-app screenshot, clothing (hackathon)

**Proof:** a stranger opens the Expo app, uploads a screenshot of an outfit, taps a product link.

**Capture.** `expo-image-picker` from camera roll or camera. Kill the URL text field as a product input. `lib/api.ts` becomes `identifyImage(uri)` — multipart upload, not `{ url }`.

**Ingest.** Almost nothing. Decode, optionally downscale long edge to ~1280px, store as the single frame in the `MediaBundle`. Upload to R2 when we have it; base64 to Baseten until then (45 MB body cap). No yt-dlp. No ffmpeg.

**See.** One (maybe two, if we also send a tighter center crop) image to Baseten vision. OpenAI Structured Outputs → `Garment[]`. PIL crops chips from bboxes.

**Source.** Shopify Global Catalog multimodal search is the Stage 1 commerce path. Composio shopping is a useful second catalog if it is free time. Browserbase is optional here — a still of a jacket should not depend on a headless browser.

**Rank / Return.** OpenAI exact vs similar. FitCards. Polling is enough; WebSocket is nice.

**Clients:** Expo Go / iOS Simulator is fine. No native overlay. No dev client required.

### Stage 2 — Device-native frame (Android)

**Proof:** user is in TikTok, pauses on a frame, taps our control, gets the same cards without opening the picker.

The identifier does not change. The bytes that used to come from `ImagePicker` now come from the OS.

#### Android (the real Stage 2)

A home-screen widget cannot see the TikTok surface. “Widget” here means a **control that lives above other apps**, plus maybe a Quick Settings tile that fires the same capture.

**Recommended capture:** Accessibility overlay bubble + `AccessibilityService.takeScreenshot()` (API 30+).

1. User grants Accessibility for Fit Stealer. We disclose: tap-to-identify, not keylogging, not always-on recording.
2. A small bubble sits over the screen (draw-over-apps).
3. User pauses the video, taps the bubble.
4. Service screenshots the current display → JPEG/PNG.
5. Native module `POST /jobs` with `{ type: "image", origin: "android_overlay" }` using the same contract as Stage 1.
6. System notification or deep link `fit-stealer://job/<id>` opens the Expo result screen.

**Also worth shipping if overlay is flaky:** a Quick Settings tile that triggers the same screenshot. `expo-widgets` home-screen widgets are polish (“last fit you identified”), not the capture path.

This **will not run in Expo Go**. Stage 2 needs a dev client / `expo prebuild` and a native Android module (e.g. `frontend/modules/android-screen-identify/`) plus a config plugin. That is why it is Stage 2, not Stage 1.

**Privacy:** capture only on tap. No frame buffer, no MediaProjection session left open, no upload until the user taps. Delete the image with the job (24h R2 lifecycle).

#### iOS (honest fallback, not a fake overlay)

iOS will not let us screenshot TikTok from a floating button. Do not promise it.

Fallbacks that still use the Stage 1 API:

- Share sheet: user screenshots (OS gesture) → share to Fit Stealer.
- “Identify last screenshot” using the photo library, optionally driven by a Shortcut.

`frontend/targets/share-extension/` is this fallback, not Stage 1.

### Stage 3 — Short video snippets

**Proof:** the same app (and the same Android control, if present) can take a few seconds of video and return a better clothing read than a single still.

**Why it is harder.** Motion blur, scene cuts, the person turning, more garments appearing, 10× the pixels, 10× the chance the VLM contradicts itself across frames.

**Ingest (the new work).**

1. Accept `{ type: "video" }` multipart (camera-roll clip, in-app recording, or a user-initiated short MediaProjection burst after an explicit tap — never always-on recording).
2. `ffmpeg` / ffprobe: cap length (e.g. 15s). Extract **3–5 keyframes**, drop near-black / tiny files.
3. Same `MediaBundle` as Stage 1, just `frames.length > 1`.
4. Stretch: if the clip is ≤30s, also send the video to Kimi on Baseten (native video-in). We still need still chips for Shopify `like`.

**See.** VLM on 2–3 frames. OpenAI **merges** garments across frames (same category + similar description). One chip per merged garment — pick the sharpest bbox.

**Source.** Browserbase earns its place: more on-screen text, possible creator product stickers, items Shopify will not have. Stagehand extract stays capped (1–2 pages, 15s).

**URL paste** (TikTok link) is an optional convenience once this ingest exists (`yt-dlp` → same frames). It is not the Stage 3 definition. If download fails, `needs_screenshot` — we already have that input.

**Jobs get slow.** This is when Cloudflare IdentifyAgent + WebSocket + KV stop being optional. A 20s video job cannot be a single blocking HTTP request from the overlay.

### Stage 4 — Any category (accessibility)

**Proof:** the same capture surfaces answer “what is on screen?” for more than clothes, including a description someone can act on.

**Do not fork the pipeline.** Generalize the contracts:

- `Garment` → `DetectedItem` with `kind: clothing | object | text | place | content | other`
- Clothing keeps Shopify / shopping tools
- Other kinds use Browserbase (what is this, where was this filmed, original post) and Composio actions (send the description, look up a label)
- `outfit_summary` → `scene_summary` (Stage 1 can already fill a clothing one-liner as a seed)

See prompt becomes category-open. Rank learns to drop clothing-shop results for a medication bottle. Vectorize is optional retrieval memory, not a rewrite.

---

## 5. The identify pipeline (steps)

These steps run for every job. Product stages change how Capture and Ingest are implemented.

### Capture

| Stage | Who | What the API receives |
| --- | --- | --- |
| 1 | Expo `ImagePicker` | `{ type: "image", origin: "app" }` + multipart |
| 2 | Android overlay / QS tile | `{ type: "image", origin: "android_overlay" }` + multipart |
| 2 iOS | Share extension / last screenshot | `{ type: "image", origin: "share" }` |
| 3 | Picker or short clip | `{ type: "video", origin: … }` + multipart |

Expo Router: `index` (capture) and `job/[id]` (results). Existing `FitCard` is the result atom. `expo-haptics` on first item. Sentry Replay + Tracing on this surface from Stage 1.

### Ingest

Turn bytes into a `MediaBundle` the rest of the pipeline can ignore the origin of.

**Image (Stages 1–2):** validate, downscale, store one frame.

**Video (Stage 3):** keyframes as above. R2 for HTTPS URLs Baseten can fetch. Local-dev fallback: base64.

**Privacy:** user-initiated only. Delete after 24h. This is not an always-on recorder, including on Android.

### See — Baseten VLM + OpenAI schema

This is the magic. If See is wrong, Source cannot save us.

**Eyes: Baseten.** `https://inference.baseten.co/v1`, OpenAI-compatible vision. Freeze one slug (`zai-org/GLM-5.3-Flash` or `moonshotai/Kimi-K2.6` after a `GET /v1/models` check). Send the still (Stage 1–2) or 2–3 frames (Stage 3) as `image_url` (R2) or base64.

Ask Stage 1–3 for garments only: category, search-ready `description`, attributes, `brand_cues` (empty if none), normalized `bbox`, confidence.

**Judgment: OpenAI Structured Outputs** (`strict: true`):

- Drop low-confidence items.
- Merge duplicates (Stage 3 frames).
- `brand = null` unless cues exist. Never invent Zara.
- `search_query` for catalogs.
- `accessibility_line` per item + `outfit_summary` for the look (Stage 4 seed).

**Crop.** PIL on each bbox → chip in R2. Source searches with the **chip**, not the full screenshot (status bars, faces, three other garments).

Existing stub: `ai-service/services/baseten_vlm.py` → `analyze_frames_with_vlm`. Keep the name even when `frames` is length 1.

### Source — fan-out per item, in parallel

None of these tools talk to the app.

#### Shopify Global Catalog (Stage 1 required)

`https://catalog.shopify.com/api/ucp/mcp` — all merchants, not one demo store. Text + image:

```json
{
  "name": "search_catalog",
  "arguments": {
    "meta": {
      "ucp-agent": {
        "profile": "https://shopify.dev/ucp/agent-profiles/2026-04-08/valid-with-capabilities.json"
      }
    },
    "catalog": {
      "query": "oversized black leather biker jacket",
      "like": [
        { "image": { "content_type": "image/jpeg", "data": "<base64 chip>" } }
      ],
      "filters": { "available": true, "ships_to": { "country": "CA" } },
      "context": { "address_country": "CA", "currency": "CAD" },
      "pagination": { "limit": 5 }
    }
  }
}
```

Then `get_product` for checkout URL, price, merchant. Replace `shopify_filter.py` with `search_shopify_catalog(item) -> ProductCandidate[]`. We do not scrape Shopify.

#### Browserbase (optional Stage 1, expected Stage 3–4)

Search API then Stagehand `extract()` on 1–2 product-like pages. Covers Grailed, SSENSE, creator stickers. Hard 15s cap. If it fails, Shopify still stands.

#### Composio (Stage 1 shopping optional; Stage 4 actions)

- `COMPOSIO_SEARCH_SHOPPING` — third catalog, no OAuth.
- After Rank: one action (`SLACK_SEND_MESSAGE` or email). Stage 4 can send a scene description, not just a fit.
- Direct tools, allowlisted. Not Tool Router over 1,000 apps.

### Rank — OpenAI

At most 3 shown matches per item.

| `match_type` | When | UI |
| --- | --- | --- |
| `exact` | Same item / SKU | Found |
| `similar` | Same category, color, silhouette | Similar |
| `weak` | Do not show | dropped |

Never promote similar to exact. Never set brand from a store name. One-line `reason` on each card. Prefer Shopify when quality is equal.

### Return

`IdentifyResult` via poll (`GET /jobs/:id`) in Stage 1. WebSocket from the Durable Object when jobs get long (Stage 3) or when the overlay should not wait on HTTP (Stage 2 nice-to-have). Group FitCards by item, badge `match_type`.

---

## 6. Canonical contracts

Stage 1 must produce these. Later stages only add fields.

### `IdentifyJob` (client → API)

```ts
type IdentifyOrigin = "app" | "android_overlay" | "android_qs" | "share";

type IdentifyJobRequest =
  | { type: "image"; origin: IdentifyOrigin }   // Stages 1–2; multipart body
  | { type: "video"; origin: IdentifyOrigin };  // Stage 3; multipart body
```

### `Garment` (See → Source, Stages 1–3)

```ts
type Garment = {
  id: string;
  category: "jacket" | "shirt" | "pants" | "shorts" | "skirt" | "dress" | "shoes" | "bag" | "hat" | "accessory";
  description: string;
  search_query: string;
  attributes: { color: string; material?: string; pattern?: string; fit?: string };
  brand: string | null;
  brand_cues: string[];
  confidence: number;
  bbox: [number, number, number, number];
  chip_key: string;
  accessibility_line: string;
};
```

Stage 4: `DetectedItem = Garment & { kind: "clothing" | "object" | "text" | "place" | "content" | "other" }` or a superset with `kind` required. Clothing jobs keep this shape.

### `ProductCandidate` / `IdentifyResult`

```ts
type ProductCandidate = {
  title: string;
  url: string;
  image_url?: string;
  price?: string;
  currency?: string;
  store_name?: string;
  source: "shopify" | "browserbase" | "composio" | "creator_tag";
  raw_score?: number;
};

type IdentifyResult = {
  job_id: string;
  status: "queued" | "ingesting" | "seeing" | "sourcing" | "ranking" | "done" | "error";
  origin: IdentifyOrigin;
  thumbnail_url?: string;
  outfit_summary?: string; // Stage 4: scene_summary
  items: Array<{
    garment: Garment;
    matches: Array<ProductCandidate & {
      match_type: "exact" | "similar";
      confidence: number;
      reason: string;
    }>;
  }>;
  error?: string;
};
```

---

## 7. Runtime design

### 7.1 HTTP API

**Stage 1 can ship on Express → FastAPI.** Do not block the screenshot demo on wrangler.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/identify` then `/jobs` | Create job from image (later: video). Returns `{ job_id }` or the full result if sync. |
| `GET` | `/jobs/:id` | Poll `IdentifyResult`. |
| `GET` | `/jobs/:id/ws` | Stage 2–3 streaming. |
| `POST` | `/jobs/:id/act` | Composio action. |
| `GET` | `/health` | Already exists. |

Today `POST /api/process-url` is a stub. Replace it. The Expo client should not send a URL in Stage 1.

**Cloudflare IdentifyAgent (`agent/`, new)** is the API we want by Stage 2–3:

- Durable Object per `job_id` (memory, step log, broadcast).
- R2 `MEDIA` for frames and chips (Baseten must GET HTTPS URLs on demo day).
- KV cache: image hash → last result (judge retries).
- Tools: perception, Shopify MCP, Browserbase, Composio, OpenAI rank.

Stage 1: Express may call FastAPI `/api/identify` synchronously. Stage 3: the Worker owns the loop because video is slow. Design the contract once so the overlay never cares which process is behind `/jobs`.

### 7.2 Perception (`ai-service/`)

Tool server, not the product API.

| Method | Path | When |
| --- | --- | --- |
| `POST` | `/tools/see` | Stage 1 — `baseten_vlm.py` |
| `POST` | `/tools/crop` | Stage 1 — PIL |
| `POST` | `/tools/ingest` | Stage 3 — `video_processor.py` (frames from video) |
| `POST` | `/api/identify` | Stage 1 fallback: see + crop (+ source if the agent is not up) |
| `GET` | `/health` | already exists |

Stage 1 Python deps: `openai`, `pillow`, `python-dotenv`. Add `yt-dlp` / ffmpeg only in Stage 3.

**Rule:** Perception does not call Shopify, Composio, or the app. Exception: the `/api/identify` fallback may call Shopify so Stage 1 can demo before the Worker exists.

### 7.3 Expo app (`frontend/`)

`lib/api.ts` is the only network module.

Stage 1 screens:

- Home: **Upload screenshot** as the primary (only) action.
- Loading: status bound to `IdentifyResult.status`.
- Results: `FitCard` list, not `JSON.stringify`.
- Empty/error in English.

Stage 2: deep link into `job/[id]`; overlay is native, not JS.
Stage 3: second button — pick / record a short video.

### 7.4 Android overlay (Stage 2 only)

Native `AccessibilityService` + bubble. Config plugin. Dev client. Talks to the same `API_BASE_URL`. Carries `origin: "android_overlay"` so Sentry and the agent can tell overlay jobs from picker jobs.

---

## 8. How a Stage 1 request moves

1. Judge screenshots a paused TikTok (OS), opens Fit Stealer, picks the image.
2. Expo `POST /api/identify` multipart.
3. API status `seeing`. Baseten VLM on the still. OpenAI emits `Garment[]`. PIL writes chips.
4. Status `sourcing`. Shopify `search_catalog` (text + chip) per garment. Optional Composio shopping.
5. Status `ranking`. OpenAI keeps ≤3, labels exact/similar.
6. Expo renders cards. Judge taps a Shopify product.

Stage 2 replaces step 1 with: pause TikTok → tap bubble → same POST. Steps 3–6 unchanged.

Stage 3 inserts ingest (frames) between 2 and 3, and may add Browserbase in step 4.

---

## 9. Sponsor map

Sponsors enter when the product stage needs them. Installing an SDK in Stage 1 for a Stage 3 job is not a prize story.

| Sponsor | Pipeline step | First product stage | On stage we say | Not this |
| --- | --- | --- | --- | --- |
| **Expo** | Capture + Return | 1 (app), 2 (dev client / widgets) | App you use in 30 seconds; later the overlay sits on the same SDK | A web wrapper |
| **Baseten** | See | 1 | Baseten is the eyes on this screenshot | Text-only LLM, H100 training |
| **OpenAI** | See schema + Rank | 1 | OpenAI decides what we are allowed to claim | A chatbot overlay |
| **Shopify** | Source | 1 | Search every merchant by a photo of the garment chip | One hardcoded store |
| **Cloudflare** | Brain | 1 contract, 2–3 required | The job is a Durable Object the overlay and the app share | Pages landing site |
| **Sentry** | Cross-cutting | 1 | Trace + Replay + Logs; a replay caught empty cards after upload | DSN only |
| **Composio** | Source + Act | 1 optional, 4 expected | Agent shops, then sends the result | 1,000 unused toolkits |
| **Browserbase** | Source | 1 optional, 3 expected | When a still (or a clip) is not on Shopify, a browser agent finds it | `fetch(html)` |
| **Cognition / Devin** | Build | anytime | Show the session that produced working See | No artifact |
| **OpenAI Codex** | Build | 1 | Codex wrote the Structured Output schemas | “Codex helped” |

**Stage 1 prize core:** Expo, Baseten, OpenAI, Shopify, Sentry. Cloudflare if the Worker is live; otherwise the contract is already Worker-shaped.

**Stage 2 Expo prize depth:** Android overlay + optional QS tile / last-fit home widget. That is a native mobile experience, not a form.

**Stage 3–4:** Browserbase, Composio actions, Cloudflare job memory, Kimi video-in.

---

## 10. Failure modes

| Failure | User sees | System |
| --- | --- | --- |
| No clothes in the still | “We couldn’t see a clear outfit in this photo.” | Honest empty state. Try another screenshot. |
| VLM invents a brand | Never shown | Schema forces `brand = null` without cues. |
| Shopify empty | Similar cards from Composio / Browserbase if those tools ran | Rank still runs. |
| Overlay permission denied | Stay on in-app upload | Stage 1 still works. Stage 2 is additive. |
| Overlay capture fails | “Couldn’t grab that frame — pick a screenshot.” | Same image job, `origin: "app"`. |
| Video too long / too dark (Stage 3) | Ask for a shorter clip or a still | Cap length; fall back to hero frame. |
| TikTok URL download blocked (optional Stage 3) | `needs_screenshot` | Do not hang on yt-dlp. |
| Worker not deployed | Express → FastAPI `/api/identify` | Stage 1 ship path. |
| iOS “overlay” requested | Share sheet / last screenshot | OS limit. Do not fake it. |

Wrong-brand exact matches are a Rank bug, not a reason to add capture types.

---

## 11. Observability (Sentry)

Same `job_id` (+ `origin`) across Expo, overlay, API, perception.

| Product | Where | What we look at |
| --- | --- | --- |
| Errors | All runtimes | Upload failures, JSON parse, overlay crashes |
| Tracing | `identify` span → See → Shopify | Which step ate the seconds |
| Session Replay | Expo Stage 1 | Pick image → loading → empty cards |
| Logs | API + perception | `garment_count`, `shopify_hits`, `origin` |

At least two products beyond errors. Let a trace change a default (image max edge, later frame count). Do not log raw pixels.

---

## 12. Local vs demo-day (Stage 1)

**Saturday (simulator):**

```text
Expo iOS Sim / Android Emulator
    → localhost:4000 Express
    → localhost:8000 FastAPI
    → Baseten / Shopify / OpenAI cloud
```

**Sunday (physical phone):**

```text
Phone → deployed API → deployed FastAPI
      → same cloud tools
```

Baseten must GET frame URLs on demo day (R2 or base64). Stage 2 demo is an Android physical device with a dev client, never Expo Go.

---

## 13. Build sequence

Order of proof. Stop and polish when a distinctive jacket in a **screenshot** comes back with a real Shopify link.

### Stage 1 (this weekend)

| Step | Proof | Becomes real |
| ---: | --- | --- |
| 0 | FitCards from fixture JSON (kill `JSON.stringify`) | Expo |
| 1 | Multipart image → Baseten `Garment[]` + chips | Baseten |
| 2 | One `search_query` + chip → live Shopify links | Shopify |
| 3 | App upload screenshot → cards | End-to-end |
| 4 | Ranker labels Similar vs Found | OpenAI |
| 5 | Sentry trace/replay on a real empty-result | Sentry |
| 6 | Optional: Worker `/jobs`, Composio shopping / Slack | Cloudflare, Composio |

### Stage 2 (after Stage 1 is demoable)

| Step | Proof |
| ---: | --- |
| 7 | Dev client + Accessibility overlay screenshots the current display |
| 8 | Overlay POST hits the same `/jobs` as the picker (`origin` differs) |
| 9 | Pause TikTok → tap bubble → FitCards |
| 10 | iOS share-sheet fallback only if there is time |

### Stage 3

| Step | Proof |
| ---: | --- |
| 11 | Video → 3–5 frames (`/tools/ingest`) |
| 12 | Merged garments better than the hero still alone |
| 13 | Browserbase fills a Shopify miss |
| 14 | Optional URL → frames, with screenshot fallback |

### Stage 4

| Step | Proof |
| ---: | --- |
| 15 | `DetectedItem.kind` beyond clothing |
| 16 | `scene_summary` a person can act on |
| 17 | Source tools chosen by kind, not a clothing search for a street sign |

**Do not start with the overlay, video, URL paste, Vectorize, or a trained fashion model.** Baseten hosted Model APIs are the See path. H100 training is a trap for this MVP.

Safe parallelism in Stage 1: one person Expo UI (0, 3), one person See (1), one person Shopify + Rank (2, 4).

---

## 14. Repo map

```text
HacktheNorth2026/
├── OVERVIEW.md
├── ARCHITECTURE.md
├── frontend/                      # Expo — Stage 1 picker + FitCards
│   ├── lib/api.ts                 # identifyImage (Stage 3: identifyVideo)
│   ├── modules/android-screen-identify/   # Stage 2, not now
│   └── targets/share-extension/   # Stage 2 iOS fallback
├── backend/                       # Express shim :4000
├── ai-service/
│   └── services/
│       ├── baseten_vlm.py         # See (Stage 1)
│       ├── shopify_filter.py      # becomes catalog search
│       ├── browserbase_scraper.py # Stage 3+
│       └── video_processor.py     # Stage 3 ingest
└── agent/                         # Cloudflare IdentifyAgent (contract in S1, required S2–3)
```

Env (Stage 1):

```text
BASETEN_API_KEY=
BASETEN_MODEL=zai-org/GLM-5.3-Flash
OPENAI_API_KEY=
SHOPIFY_AGENT_PROFILE_URL=
SENTRY_DSN=
AI_SERVICE_URL=http://localhost:8000
```

Add `BROWSERBASE_*`, `COMPOSIO_API_KEY`, R2, and `OPENAI` for Stagehand when those stages start.

`SHOPIFY_API_KEY` in `.env.example` is the wrong model. Global Catalog uses an **agent profile**, not a storefront admin key.

---

## 15. What this architecture refuses

- URL paste or share sheet as the Stage 1 happy path.
- An iOS overlay that screenshots TikTok.
- Always-on screen recording in the name of Stage 2 or 3.
- Video work before a still screenshot demo is right.
- A second backend for the Android overlay.
- A second pipeline for “accessibility mode.”
- Training a fashion model on Baseten H100s this weekend.
- One Shopify store we control, stuffed with demo SKUs.
- Perfect SKU matching as a launch criterion.

---

## 16. Demo scripts

**Stage 1 (hackathon):**

1. Distinctive outfit on TikTok. Pause. OS screenshot.
2. Open Fit Stealer. Upload it.
3. Cards with Found / Similar. One Shopify link with a real price.
4. Tap through.
5. Close on the roadmap: this same job will live under an Android bubble, then on a clip, then on anything on screen.

**Stage 2 (when it exists):** skip the picker. Pause → tap bubble → same cards.

---

## 17. Decision log

| Decision | Choice | Why |
| --- | --- | --- |
| Stage 1 input | Screenshot only | Prove the identifier before capture chrome or video |
| Stage 2 capture | Android Accessibility overlay + `takeScreenshot` | Only practical “paused frame” path; not a home-screen widget |
| Stage 2 iOS | Share / last screenshot | OS will not screenshot other apps for us |
| Stage 3 | Video → frames, same See | Motion is extra signal on a working still engine |
| Stage 4 | Generalize `DetectedItem` | Accessibility is the product, clothing is mode one |
| Overlay vs API | Same `/jobs` | Native layer is a thinner client |
| Orchestrator | Express sync in S1; Cloudflare DO by S2–3 | Functionality first; long jobs and overlay need a brain |
| Eyes | Baseten vision Model APIs | Pixels, hosted, OpenAI-compatible |
| Claims | OpenAI Structured Outputs | Honesty schema + ranker |
| Commerce | Shopify Global Catalog multimodal | Chip image + text, all merchants |
| Express | Shim | App already on :4000 |

When something in the code disagrees with this file, this file wins until we deliberately change it.
