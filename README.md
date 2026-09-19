# Fit Stealer

Fit Stealer is a full-stack AI app designed to extract fashion outfits directly from TikTok videos, match clothing items via Vision-Language Models (VLM) & reverse search agents, and provide direct e-commerce purchase links.

---

## 🏗️ Project Architecture

```
FitStealer/
├── frontend/                      # Expo (React Native) — port 3000, opens iOS Simulator
│   ├── app/                       # Expo Router file-based routes
│   ├── components/                # Reusable UI components
│   ├── lib/                       # API clients (calls backend on port 4000)
│   └── targets/share-extension/   # Native iOS & Android share targets
│
├── backend/                       # Node.js Express API — port 4000
│   └── src/index.js               # HTTP API that proxies to the AI service
│
├── ai-service/                    # Python FastAPI AI pipeline — port 8000
│   ├── main.py                    # FastAPI server & route handlers
│   ├── requirements.txt           # Python dependencies
│   └── services/                  # Business logic & AI agent integrations
│       ├── video_processor.py     # Download & frame extraction
│       ├── baseten_vlm.py         # Vision-Language Model tagging
│       ├── browserbase_scraper.py # Headless browser search agents
│       └── shopify_filter.py      # E-commerce link filtering
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
- `SHOPIFY_API_KEY`: Shopify Storefront / Commerce API key
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

Health checks:

- Backend: `http://localhost:4000/health`
- AI service: `http://localhost:8000/health`

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

---

## 📡 API Endpoints

The frontend calls the backend on port **4000**. The backend proxies `/api/process-url` to the AI service on port **8000**.

| Method | Endpoint           | Description                                        |
| ------ | ------------------ | -------------------------------------------------- |
| `GET`  | `/health`          | Server health status check                         |
| `POST` | `/api/process-url` | Processes a TikTok video URL to extract outfit links |

---

## 📄 License

MIT
