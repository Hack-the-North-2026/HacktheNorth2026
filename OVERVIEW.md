# Project Overview

**Working name:** Fit Stealer  
**One-liner:** Shazam, but for anything on your screen — starting with clothes.

<<<<<<< HEAD
This file is the north star for the hackathon build. The README covers how to run the stack. This document covers *what we are building, why, and in what order*. How we execute it — pipeline, runtimes, contracts, and sponsor stages — is in [ARCHITECTURE.md](./ARCHITECTURE.md).
=======
This file is the north star for the hackathon build. The README covers how to run the stack. This document covers *what we are building, why, and in what order*.
>>>>>>> 47ae777893b403782dd7c9f7220b69678c8d86f3

---

## The idea

Shazam listens to the world and tells you the song. We want the same instinct for **visual media**.

<<<<<<< HEAD
You are scrolling TikTok or Reels. Someone is wearing a jacket you like. Today that means pausing, screenshotting, reverse-searching, and hoping. We want:
=======
You are scrolling TikTok or Reels. Someone is wearing a jacket you like, or the clip itself is a remix of something you want to find. Today that means pausing, screenshotting, reverse-searching, and hoping. We want:
>>>>>>> 47ae777893b403782dd7c9f7220b69678c8d86f3

> See it → identify it → get the source.

That is the product. Clothing is the first vertical, not the whole company.

---

## End goal: Shazam for accessibility

The long-term product is a **source identifier for whatever is on screen**.

<<<<<<< HEAD
A user should be able to capture a moment from their phone — a paused frame, a screenshot, a short clip — and ask:
=======
A user should be able to capture a moment from their phone — a video, a screenshot, a shared Reel, a live camera glance — and ask:
>>>>>>> 47ae777893b403782dd7c9f7220b69678c8d86f3

- What is this?
- Where did it come from?
- Where can I get it / see the original / understand it?

That includes, over time:

| Category | Example question |
| --- | --- |
| Clothing | What is this jacket, and where can I buy it? |
| Content | What is the original post, sound, or creator? |
| Objects | What is this product, plant, medication bottle, or menu item? |
| Places | Where was this filmed? |
| Accessibility | Describe what is on screen so someone can act on it. |

**Accessibility is the framing, not a bolt-on.** The same identification engine that finds a hoodie can also describe an outfit, read a label, or name an object for someone who cannot. “Shazam for the visual world” is useful for everyone and especially useful when searching by text is not an option.

<<<<<<< HEAD
We do not build all of that at once. We prove the engine on one still image of clothes, then move the capture into the OS, then give it motion, then open the category.

---

## The four stages

This is the only order that matters. Later stages reuse the same identify job. They do not replace it.

```text
Stage 1  Screenshot, in-app, clothing     ← this hackathon
Stage 2  Device-native frame (Android)
Stage 3  Short video snippets
Stage 4  Any category — accessibility
```

A native gesture on a broken identifier is worse than a screenshot button that actually works. Video on a pipeline that cannot read a still is worse than a still that is right. Any-category on a clothing engine that lies is worse than clothing that is honest.

### Stage 1 — Functional MVP (now)

Ship a real mobile app a judge can use in 30 seconds.

**Input:** the user uploads a screenshot or photo from inside the app. That is the only capture path.

**Output:** clothing items visible in that image, each with the best source / product links we can honestly return.

If we cannot find the exact SKU, a strong similar match plus a clear description still counts. Wrong-brand guesses do not.

**In scope**

- Open the Expo app on iOS or Android
- Pick a screenshot / photo (camera roll or camera)
- Backend identifies garments as well as it can
- App shows item cards with shop / source links

**Out of scope until Stage 1 works**

- Paste a TikTok / Reel URL
- Share sheet, widgets, overlays, Quick Settings tiles
- Video upload or frame extraction
- Categories other than clothing
- Accounts, social feeds, or a marketplace
- Perfect SKU matching for every fast-fashion item

### Stage 2 — Device-native frame capture

After the in-app screenshot loop is trustworthy, stop asking the user to leave TikTok, screenshot, open our app, and pick a file.

**Android (the real Stage 2):** user pauses a video on the frame they care about, taps our overlay / tile, and that frame is identified. Same clothing scope. Same backend. New capture surface.

**iOS:** other apps cannot be screenshotted from the background the way Android can. Stage 2 on iOS is a thinner fallback (share sheet, “identify last screenshot”), not a floating button over TikTok. Do not block Stage 2 on an iOS overlay that the OS will not allow.

The native layer is a **thinner capture surface** on top of the Stage 1 API. It is not a second product.

### Stage 3 — Video alongside screenshots

Once device-native stills work, accept **short video snippets** as a second media type: in-app upload and, where the OS allows, a user-initiated short capture from the same native control.

The agent now has motion, multiple angles, and on-screen text across time. It is also slower and easier to get wrong. Stage 3 exists to make the *same* clothing identifier better, not to add new categories.

URL-paste of a TikTok is a convenience on top of “we can process video.” It is not a Stage 3 requirement.

### Stage 4 — Accessibility: any category

The final expansion. Capture does not change (screenshot, native frame, short clip). The identifier stops being clothing-only.

Same engine, broader See prompt and Source tools: objects, text, places, original content, and a description of what is on screen so someone can act. Clothing remains one mode.

---

## User flow (Stage 1)

```text
Paused TikTok / Reels / any photo
        │
        └─ upload screenshot in the app
=======
We are not building all of that this weekend. We are building a pipeline that can grow into it.

---

## MVP: clothing only

Hackathon scope is **outfit identification from short-form video and screenshots**.

If a person is wearing clothes on screen, the app should:

1. Detect the visible clothing items (jacket, shirt, pants, shoes, bag, etc.).
2. Describe each item well enough to search (color, type, material, brand cues).
3. Return the closest buyable or identifiable sources (product pages, similar items, brand if confident).

If we cannot find the exact SKU, a strong similar match plus a clear description still counts as a successful MVP. Wrong-brand guesses do not.

### In scope for the MVP

- Paste a TikTok / Reel URL
- Share a video or link into the app from TikTok (or the system share sheet)
- Upload a screenshot / photo
- Return a list of clothing items with source / shop links

### Out of scope until the clothing MVP works

- Identifying memes, original posts, filming locations, food, plants, etc.
- A system-wide always-on listener like Shazam’s hardware button
- Perfect SKU matching for every fast-fashion item
- Accounts, social feeds, or a marketplace

---

## Build attitude: app first, OS-native later

Shazam is famous because it is **in the OS**: hold a button, it listens, you get the song. That is the end-state UX.

We will not start there.

Shazam also started as an app you open on purpose. We copy that order:

```
Phase 1 — Working mobile app     ← this hackathon
Phase 2 — Expand what we identify
Phase 3 — Device-native capture (Shazam-like)
```

### Phase 1 — Functional application (now)

Ship a real mobile app a judge can use in 30 seconds.

**Inputs the app must support:**

1. **Paste URL** — user copies a TikTok / Instagram Reel link and pastes it.
2. **Share from TikTok / Reels** — user hits share → our app, and we receive the URL or media.
3. **Upload screenshot / photo** — user picks an image from camera roll (or takes one).

**Output:** identified clothing items + source / product links.

Until this loop is reliable, we do not spend time on background listening, Control Center widgets, or “hold to identify.” A native gesture on a broken identifier is worse than a paste-a-link screen that actually works.

### Phase 2 — Broader media (after MVP)

Reuse the same capture → understand → source pipeline for other categories: original content, objects, places, accessibility descriptions. Clothing stays one mode, not the whole product.

### Phase 3 — Device-native platform (after the app works)

Once identification is trustworthy in-app, wrap it in OS-level capture:

- iOS share extension / Android send intent (already stubbed)
- Home Screen / Control Center / Action Button shortcut
- Optional overlay or “identify what’s on screen” flow closer to Shazam

The native layer is a **thinner capture surface** on top of the same backend. It is not a second product.

---

## User flows (Phase 1)

```text
TikTok / Reels / photo
        │
        ├─ paste URL
        ├─ share to app
        └─ upload screenshot
>>>>>>> 47ae777893b403782dd7c9f7220b69678c8d86f3
                │
                ▼
         Fit Stealer app
                │
                ▼
<<<<<<< HEAD
     backend  →  identifier
                │
     detect clothes → search sources
=======
     backend  →  AI service
                │
     detect items → search sources
>>>>>>> 47ae777893b403782dd7c9f7220b69678c8d86f3
                │
                ▼
     item cards with links
```

<<<<<<< HEAD
**Happy path for judges:** open app → upload a screenshot of a distinctive outfit → see the fit broken into items → tap through to a product.

Stage 2 happy path: pause TikTok → tap overlay → same cards, never opened the picker.
=======
**Happy path for judges:** open app → paste a TikTok URL (or share one) → see the fit broken into items → tap through to a product.
>>>>>>> 47ae777893b403782dd7c9f7220b69678c8d86f3

---

## How the system works

<<<<<<< HEAD
The repo is already split the way Stage 1 needs. Capture changes in Stage 2. Media type changes in Stage 3. Category changes in Stage 4. The job does not.

| Piece | Where | Job |
| --- | --- | --- |
| Mobile app | `frontend/` (Expo / React Native) | Stage 1: pick a screenshot, show results. Stage 2: Android overlay talks to the same API. |
| API | `backend/` (Express, port 4000) | App-facing HTTP. Proxies to the identifier. |
| Identifier | `ai-service/` (FastAPI, port 8000) | Read the image (later: frames from video), detect, find sources. |
| Native capture | Android overlay / tile (Stage 2) | Screenshot the current frame. Not a second backend. |

**Identify pipeline (all four stages):**

1. **Capture** — screenshot in-app (1), OS frame (2), or short video (3).
2. **Ingest** — image bytes, or video → frames. Always a `MediaBundle`.
3. **See** — vision model tags what is on screen (clothes first; any category in Stage 4).
4. **Source** — search for matching or similar sources.
5. **Rank** — honest exact vs similar.
6. **Return** — structured items the app can render as cards.

The frontend should never talk to the model layer directly. The app (and later the overlay) talks to the backend; the backend talks to the models. That is why Stage 2 can exist without forking the product.
=======
The repo is already split the way Phase 1 needs:

| Piece | Where | Job |
| --- | --- | --- |
| Mobile app | `frontend/` (Expo / React Native) | Capture URL, share, or screenshot. Show results. |
| API | `backend/` (Express, port 4000) | App-facing HTTP. Proxies to the AI service. |
| Identifier | `ai-service/` (FastAPI, port 8000) | Download / read media, detect clothes, find sources. |
| Share target | `frontend/targets/share-extension/` | Later: receive shares from TikTok without opening the app first. |

**AI pipeline (clothing MVP):**

1. **Ingest** — URL → video frames, or image bytes from a screenshot.
2. **See** — vision model tags garments, attributes, and optional brand cues.
3. **Source** — search / scrape for matching or similar products.
4. **Return** — structured items the app can render as cards.

The frontend should never talk to the AI service directly. The app talks to the backend; the backend talks to the model layer. That keeps Phase 3 (native capture) on the same API.
>>>>>>> 47ae777893b403782dd7c9f7220b69678c8d86f3

---

## Success for this hackathon

We win the weekend if a stranger can:

<<<<<<< HEAD
1. Open the mobile app.
2. Upload a screenshot.
3. Get back clothing items that are recognizably from that image.
4. Tap a source / product link.

Stretch, only after that works, and only in this order:

- Android overlay / Quick Settings tile that identifies the paused frame (Stage 2).
- Short video upload on the same clothing engine (Stage 3 start).
- A one-line accessibility description of the outfit (seed of Stage 4, not Stage 4).

We do **not** need a Shazam button to impress judges if the screenshot path is wrong. We need the identification to feel instant and obviously right.
=======
1. Open the iOS app.
2. Give it a TikTok, a shared Reel, *or* a screenshot.
3. Get back clothing items that are recognizably from that video.
4. Tap a source / product link.

Stretch, only after that works:

- Share-sheet entry so they never have to copy a URL.
- A second media type (e.g. “what is the original sound / post”).
- A one-line accessibility description of the outfit.

We do **not** need a Shazam button on the lock screen to impress judges. We need the identification to feel instant and obviously right.
>>>>>>> 47ae777893b403782dd7c9f7220b69678c8d86f3

---

## Product principles

1. **Identify first, shop second.** The magic is “I know what that is,” not a feed of ads.
2. **Honest matches.** Prefer “similar black leather jacket — $X” over a confident wrong brand.
<<<<<<< HEAD
3. **One pipeline, many captures.** In-app screenshot, Android overlay, and later video all hit the same identifier.
4. **Functionality before OS chrome.** Native capture is earned by a working app.
5. **Still before motion.** Video is more data and more failure. It comes after stills work.
6. **Clothing now, everything later.** Do not fork the architecture for the first vertical.
=======
3. **One pipeline, many inputs.** URL, share, and screenshot all hit the same identifier.
4. **App proof before OS chrome.** Native capture is earned by a working app.
5. **Clothing now, everything later.** Do not fork the architecture for the first vertical.
>>>>>>> 47ae777893b403782dd7c9f7220b69678c8d86f3

---

## What this is not

- Not a TikTok clone or social network.
- Not a generic chatbot with a camera.
- Not “only a shopping app.” Shopping links are how we prove we found the source.
<<<<<<< HEAD
- Not an always-on screen recorder. Privacy-respecting, user-initiated capture only — even in Stage 2.
- Not an iOS overlay over other apps. That is an OS limit, not a missing feature.

---

## Suggested demo script (Stage 1)

1. Show a TikTok of a clear, distinctive outfit. Pause it. Screenshot it.
2. Open Fit Stealer. Upload that screenshot.
3. Show items appearing with sources.
4. Tap a product.
5. Close on the vision: same identify job will later live under a widget, then on video, then on anything on screen — clothing is the first song this Shazam learned to hear.
=======
- Not an always-on screen recorder. Privacy-respecting, user-initiated capture only.

---

## Suggested demo script

1. Show a TikTok of a clear, distinctive outfit.
2. Share it into Fit Stealer (or paste the URL if share is not ready).
3. Show items appearing with sources.
4. Optionally drop in a screenshot of a different fit to prove the second input.
5. Close on the vision: same gesture, any media on screen — clothing is just the first song Shazam learned to hear.
>>>>>>> 47ae777893b403782dd7c9f7220b69678c8d86f3
