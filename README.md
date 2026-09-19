# Fit Stealer

Fit Stealer is a full-stack AI mobile app designed to extract fashion outfits directly from TikTok videos, match clothing items via Vision-Language Models (VLM) & reverse search agents, and provide direct e-commerce purchase links.

---

## 🏗️ Project Architecture

```
FitStealer/
├── mobile/                        # Expo (React Native) Frontend
│   ├── app/                       # Expo Router file-based routes
│   ├── components/                # Reusable UI components
│   ├── lib/                       # API clients & network utilities
│   └── targets/share-extension/   # Native iOS & Android share targets
│
├── backend/                       # Python FastAPI Backend
│   ├── main.py                    # FastAPI server & route handlers
│   ├── requirements.txt           # Python dependencies
│   └── services/                  # Business logic & AI agent integrations
│       ├── video_processor.py     # Download & frame extraction
│       ├── baseten_vlm.py         # Vision-Language Model tagging
│       ├── browserbase_scraper.py # Headless browser search agents
│       └── shopify_filter.py     # E-commerce link filtering
│
└── .env.example                   # Environment configuration template
```

---

## ⚡ Quick Start & Development

### 1. Environment Setup

Copy `.env.example` to create your local `.env` file:

```bash
cp .env.example .env
```

Set your API keys:
- `BASETEN_API_KEY`: Baseten platform key for VLM inference
- `BROWSERBASE_API_KEY`: Browserbase key for headless web scraping
- `SHOPIFY_API_KEY`: Shopify Storefront / Commerce API key
- `BACKEND_PORT`: `8000` (Default)

---

### 2. Starting the Backend Server (FastAPI)

1. Navigate to the `backend/` directory:
   ```bash
   cd backend
   ```

2. Create a virtual environment and activate it:
   ```bash
   python -m venv venv
   # On Windows:
   .\venv\Scripts\activate
   # On macOS/Linux:
   source venv/bin/activate
   ```

3. Install required dependencies:
   ```bash
   pip install -r requirements.txt
   ```

4. Launch the development server:
   ```bash
   python main.py
   # Or using uvicorn directly:
   uvicorn main:app --reload --port 8000
   ```

The backend server will run at `http://localhost:8000`. Test the health endpoint at `http://localhost:8000/health`.

---

### 3. Starting the Mobile Server (Expo)

1. Navigate to the `mobile/` directory:
   ```bash
   cd mobile
   ```

2. Install npm dependencies (if not already installed):
   ```bash
   npm install
   ```

3. Start the Expo development server:
   ```bash
   npx expo start
   ```

4. Press `a` for Android Emulator, `i` for iOS Simulator, or scan the QR code with the Expo Go app.

---

### 🚀 Running Both Concurrently

To run both backend and mobile applications concurrently from the root directory:

#### Using `concurrently` (NPM):
Run from root:
```bash
npx concurrently "cd backend && python main.py" "cd mobile && npx expo start"
```

#### Or in separate terminal windows:
- **Terminal 1 (Backend):** `cd backend && python main.py`
- **Terminal 2 (Mobile):** `cd mobile && npx expo start`

---

## 📡 API Endpoints

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/health` | Server health status check |
| `POST` | `/api/process-url` | Processes TikTok video URL to extract outfit links |

---

## 📄 License
MIT
