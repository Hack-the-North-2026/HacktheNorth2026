# Project Overview

**Working name:** Fit Stealer  
**One-liner:** Shazam, but for anything on your screen — starting with clothes.

This file is the north star for the hackathon build. The README covers how to run the stack. This document covers *what we are building, why, and in what order*.

---

## The idea

Shazam listens to the world and tells you the song. We want the same instinct for **visual media**.

You are scrolling TikTok or Reels. Someone is wearing a jacket you like, or the clip itself is a remix of something you want to find. Today that means pausing, screenshotting, reverse-searching, and hoping. We want:

> See it → identify it → get the source.

That is the product. Clothing is the first vertical, not the whole company.

---

## End goal: Shazam for accessibility

The long-term product is a **source identifier for whatever is on screen**.

A user should be able to capture a moment from their phone — a video, a screenshot, a shared Reel, a live camera glance — and ask:

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
                │
                ▼
         Fit Stealer app
                │
                ▼
     backend  →  AI service
                │
     detect items → search sources
                │
                ▼
     item cards with links
```

**Happy path for judges:** open app → paste a TikTok URL (or share one) → see the fit broken into items → tap through to a product.

---

## How the system works

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

---

## Success for this hackathon

We win the weekend if a stranger can:

1. Open the iOS app.
2. Give it a TikTok, a shared Reel, *or* a screenshot.
3. Get back clothing items that are recognizably from that video.
4. Tap a source / product link.

Stretch, only after that works:

- Share-sheet entry so they never have to copy a URL.
- A second media type (e.g. “what is the original sound / post”).
- A one-line accessibility description of the outfit.

We do **not** need a Shazam button on the lock screen to impress judges. We need the identification to feel instant and obviously right.

---

## Product principles

1. **Identify first, shop second.** The magic is “I know what that is,” not a feed of ads.
2. **Honest matches.** Prefer “similar black leather jacket — $X” over a confident wrong brand.
3. **One pipeline, many inputs.** URL, share, and screenshot all hit the same identifier.
4. **App proof before OS chrome.** Native capture is earned by a working app.
5. **Clothing now, everything later.** Do not fork the architecture for the first vertical.

---

## What this is not

- Not a TikTok clone or social network.
- Not a generic chatbot with a camera.
- Not “only a shopping app.” Shopping links are how we prove we found the source.
- Not an always-on screen recorder. Privacy-respecting, user-initiated capture only.

---

## Suggested demo script

1. Show a TikTok of a clear, distinctive outfit.
2. Share it into Fit Stealer (or paste the URL if share is not ready).
3. Show items appearing with sources.
4. Optionally drop in a screenshot of a different fit to prove the second input.
5. Close on the vision: same gesture, any media on screen — clothing is just the first song Shazam learned to hear.
