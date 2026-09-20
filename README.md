# Fit Stealer

Fit Stealer identifies what is on screen — starting with clothes from a screenshot.

The long-term vision is **Shazam for anything on your screen**. Build order is screenshot-in-app (Stage 1), Android device-native frame capture (Stage 2), short video (Stage 3), then any category / accessibility (Stage 4). See [OVERVIEW.md](./OVERVIEW.md) for product stages and [ARCHITECTURE.md](./ARCHITECTURE.md) for how we execute them.

---

## 🏗️ Project Architecture

```
FitStealer/
├── frontend/                      # Expo (React Native) — port 3000, opens iOS Simulator
│   ├── app/                       # Expo Router file-based routes
│   ├── components/                # Reusable UI components
│   ├── lib/                       # API clients (calls backend on port 4000)
│   └── targets/share-extension/   # Stage 2 iOS fallback (share / last screenshot)
│
├── backend/                       # Node.js Express API — port 4000
│   └── src/index.js               # HTTP API that proxies to the AI service
│
├── ai-service/                    # Python FastAPI AI pipeline — port 8000
│   ├── main.py                    # FastAPI server & route handlers
│   ├── requirements.txt           # Python dependencies
│   └── services/                  # Business logic & AI agent integrations
│
├── agent/                         # Cloudflare IdentifyAgent (Workers + Durable Object + KV + R2)
│   └── src/identify-agent.ts      # matching loop: see → detail → retrieve → judge → maybe browse → rank
│
├── package.json                   # Root scripts (`npm run dev` starts all services)
└── .env.example                   # Environment configuration template
```

| Service    | Directory     | Port | Stack              |
| ---------- | ------------- | ---- | ------------------ |
| Frontend   | `frontend/`   | 3000 | Expo / React Native |
| Backend    | `backend/`    | 4000 | Node.js / Express  |
| AI service | `ai-service/` | 8000 | Python / FastAPI   |

The frontend talks to the backend. The backend forwards processing requests to the AI service.

---

## ⚡ Quick Start & Development

### 1. Environment Setup

Copy `.env.example` to create your local `.env` file:

```bash
cp .env.example .env
```

Set your API keys and ports:

- `BASETEN_API_KEY`: Baseten platform key for VLM inference
- `BROWSERBASE_API_KEY`: Browserbase key for headless web scraping
- `OPENAI_API_KEY`: OpenAI key used by the exact-versus-similar ranker
- `SHOPIFY_AGENT_PROFILE_URL`: public UCP profile used for Shopify Global Catalog search (no Shopify API key is required)
- `BACKEND_PORT`: `4000` (default)
- `AI_SERVICE_PORT`: `8000` (default)
- `AI_SERVICE_URL`: `http://localhost:8000` (used by the backend to reach the AI service)

### 2. Install Dependencies

From the project root:

```bash
npm install
npm run install:all
```

Then set up the Python AI service:

```bash
cd ai-service
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cd ..
```

`npm run dev` uses `ai-service/venv` automatically when it exists.

### 3. Start All Services

From the project root:

```bash
npm run dev
```

This starts:

- Frontend Metro bundler at `http://localhost:3000`
- Backend: `http://localhost:4000`
- AI service: `http://localhost:8000`
- The **iOS Simulator** (iPhone 17) with the app in Expo Go

### Terminal logging

`npm run dev` prints structured logs from the backend and AI service in the same
terminal. Each entry includes a timestamp, severity, service, event, and useful
request or job context. Warnings, HTTP failures, unhandled exceptions, and stack
traces are shown without logging API keys, image bytes, or base64 chips.

Set `LOG_LEVEL=debug` in `.env` to include routine job-poll requests. The default
`LOG_LEVEL=info` keeps those polls quiet while still showing every warning and
error.

Health checks:

- Backend: `http://localhost:4000/health`
- AI service: `http://localhost:8000/health`

Matching golden set (Stage G):

```bash
cd ai-service
./venv/bin/python -m evals.run_golden
./evals/demo.sh path/to/known-good-screenshot.jpg
```

---

### iOS Simulator

Install Xcode so the iOS Simulator is available.

From the project root, `npm run dev` boots **iPhone 17**, installs Expo Go on first launch if needed, and opens the app:

```bash
npm run dev
```

To start only the frontend on the simulator:

```bash
cd frontend
npm run ios
```

`npm run ios` and `npm run dev` in `frontend/` both boot the simulator, wait until Metro is up on port 3000, then open `exp://127.0.0.1:3000` in Expo Go.

If the Simulator window is already open, bring it to the front. If the app does not appear, open Expo Go on the simulator and load `exp://127.0.0.1:3000`.

For other clients instead of the simulator:

```bash
cd frontend
npm run web      # web browser
npm run android  # Android Emulator
```

### Starting Services Individually

**Backend (Express on port 4000):**

```bash
cd backend
npm run dev
```

**AI service (FastAPI on port 8000):**

```bash
cd ai-service
npm run dev
# Or:
source venv/bin/activate
uvicorn main:app --reload --port 8000
```

**Cloudflare IdentifyAgent (same `/api/identify` + `/jobs/:id` contract):**

```bash
cd agent
cp .dev.vars.example .dev.vars
npm install
npx wrangler dev
```

---

## 📡 API Endpoints

The frontend talks to the backend on port **4000**. The backend talks to the AI service on port **8000**. Stage 1 is a screenshot upload, not a TikTok URL.

| Method | Endpoint | Description |
| ------ | --- | --- |
| `GET`  | `/health` | Server health status check |
| `POST` | `/api/identify` | Stage 1: multipart image → clothing items + source links |
| `GET`  | `/jobs/:id` | Poll `IdentifyResult` (`seeing` → `detailing` → `sourcing` → `judging` → `retrying` → `ranking`) |
| `POST` | `/tools/retrieve` `/judge` `/browse` `/rank` | Internal matching tools (Express or Cloudflare IdentifyAgent) |
| `POST` | `/tools/source-rank` | Combined retrieve→judge→browse→rank fallback |
| `POST` | `/api/process-url` | Legacy stub; do not build Stage 1 on this |

Point Expo at the Cloudflare IdentifyAgent by setting `EXPO_PUBLIC_API_BASE_URL` to the Worker URL (`cd agent && npx wrangler dev` after `npm install`).

---

## 📄 License

MIT
