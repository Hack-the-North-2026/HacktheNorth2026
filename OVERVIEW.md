# Project Overview

**Working name:** Fit Stealer  
**One-liner:** Shazam, but for anything on your screen — starting with clothes.

This file is the north star for the hackathon build. The README covers how to run the stack. This document covers *what we are building, why, and in what order*. How we execute it — pipeline, runtimes, contracts, and sponsor stages — is in [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## The idea

Shazam listens to the world and tells you the song. We want the same instinct for **visual media**.

You are scrolling TikTok or Reels. Someone is wearing a jacket you like. Today that means pausing, screenshotting, reverse-searching, and hoping. We want:

> See it → identify it → get the source.

That is the product. Clothing is the first vertical, not the whole company.

---

## End goal: Shazam for accessibility

The long-term product is a **source identifier for whatever is on screen**.

A user should be able to capture a moment from their phone — a paused frame, a screenshot, a short clip — and ask:

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
                │
                ▼
         Fit Stealer app
                │
                ▼
     backend  →  identifier
                │
     detect clothes → search sources
                │
                ▼
     item cards with links
```

**Happy path for judges:** open app → upload a screenshot of a distinctive outfit → see the fit broken into items → tap through to a product.

Stage 2 happy path: pause TikTok → tap overlay → same cards, never opened the picker.

---

## How the system works

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

---

## Success for this hackathon

We win the weekend if a stranger can:

1. Open the mobile app.
2. Upload a screenshot.
3. Get back clothing items that are recognizably from that image.
4. Tap a source / product link.

Stretch, only after that works, and only in this order:

- Android overlay / Quick Settings tile that identifies the paused frame (Stage 2).
- Short video upload on the same clothing engine (Stage 3 start).
- A one-line accessibility description of the outfit (seed of Stage 4, not Stage 4).

We do **not** need a Shazam button to impress judges if the screenshot path is wrong. We need the identification to feel instant and obviously right.

---

## Product principles

1. **Identify first, shop second.** The magic is “I know what that is,” not a feed of ads.
2. **Honest matches.** Prefer “similar black leather jacket — $X” over a confident wrong brand.
3. **One pipeline, many captures.** In-app screenshot, Android overlay, and later video all hit the same identifier.
4. **Functionality before OS chrome.** Native capture is earned by a working app.
5. **Still before motion.** Video is more data and more failure. It comes after stills work.
6. **Clothing now, everything later.** Do not fork the architecture for the first vertical.

---

## What this is not

- Not a TikTok clone or social network.
- Not a generic chatbot with a camera.
- Not “only a shopping app.” Shopping links are how we prove we found the source.
- Not an always-on screen recorder. Privacy-respecting, user-initiated capture only — even in Stage 2.
- Not an iOS overlay over other apps. That is an OS limit, not a missing feature.

---

## Suggested demo script (Stage 1)

1. Show a TikTok of a clear, distinctive outfit. Pause it. Screenshot it.
2. Open Fit Stealer. Upload that screenshot.
3. Show items appearing with sources.
4. Tap a product.
5. Close on the vision: same identify job will later live under a widget, then on video, then on anything on screen — clothing is the first song this Shazam learned to hear.
