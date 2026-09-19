# Fit Stealer

Fit Stealer is a full-stack AI app designed to extract fashion outfits directly from TikTok videos, match clothing items via Vision-Language Models (VLM) & reverse search agents, and provide direct e-commerce purchase links.

---

## Project Architecture

```
FitStealer/
├── frontend/                      # Expo (React Native / web) — port 3000
│   ├── app/                       # Expo Router file-based routes
│   ├── components/                # Reusable UI components
│   ├── lib/                       # API clients & network utilities
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
└── .env.example                   # Environment configuration template
```

| Service     | Directory     | Port |
| ----------- | ------------- | ---- |
| Frontend    | `frontend/`   | 3000 |
| Backend     | `backend/`    | 4000 |
| AI service  | `ai-service/` | 8000 |

---

## Quick Start

### 1. Environment Setup

```bash
cp .env.example .env
```

Set your API keys:
- `BASETEN_API_KEY`: Baseten platform key for VLM inference
- `BROWSERBASE_API_KEY`: Browserbase key for headless web scraping
- `SHOPIFY_API_KEY`: Shopify Storefront / Commerce API key

### 2. Install dependencies

```bash
npm install
npm run install:all
cd ai-service && python3 -m venv venv && source venv/bin/activate && pip install -r requirements.txt && cd ..
```

If you created a venv, either keep it activated or install packages globally/`python3 -m pip` so `npm run dev` can start the AI service.

### 3. Start everything

From the project root:

```bash
npm run dev
```

This starts:
- Frontend at `http://localhost:3000`
- Backend at `http://localhost:4000`
- AI service at `http://localhost:8000`

Health checks:
- Backend: `http://localhost:4000/health`
- AI service: `http://localhost:8000/health`

---

## API Endpoints

The frontend calls the backend on port 4000. The backend forwards processing to the AI service.

| Method | Endpoint           | Description                                      |
| ------ | ------------------ | ------------------------------------------------ |
| `GET`  | `/health`          | Server health status check                       |
| `POST` | `/api/process-url` | Processes TikTok video URL to extract outfit links |

---

## License
MIT
