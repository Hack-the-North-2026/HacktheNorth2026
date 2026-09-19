from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, HttpUrl

app = FastAPI(title="Fit Stealer API", version="0.1.0")

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
    return {"status": "ok", "service": "Fit Stealer API"}

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
    import os
    from dotenv import load_dotenv

    load_dotenv()
    port = int(os.getenv("BACKEND_PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
