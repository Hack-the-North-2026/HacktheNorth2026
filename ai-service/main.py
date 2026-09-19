import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, HttpUrl

load_dotenv(Path(__file__).resolve().parent.parent / ".env")
load_dotenv()

app = FastAPI(title="Fit Stealer AI Service", version="0.1.0")

# Enable CORS for local Expo development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class ProcessUrlRequest(BaseModel):
    url: str

@app.get("/")
@app.get("/health")
def health_check():
    return {"status": "ok", "service": "Fit Stealer AI Service"}

@app.post("/api/process-url")
def process_url(payload: ProcessUrlRequest):
    if not payload.url:
        raise HTTPException(status_code=400, detail="URL is required")
    
    # Placeholder implementation for TikTok video processing pipeline
    return {
        "status": "success",
        "message": "TikTok URL received for processing",
        "url": payload.url,
        "results": []
    }

if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("AI_SERVICE_PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
