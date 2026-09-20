"""Human-readable terminal logging for the AI service."""

from __future__ import annotations

import logging
import os
import sys
from contextvars import ContextVar
from datetime import datetime
from typing import Any

job_id_var: ContextVar[str | None] = ContextVar("fit_stealer_job_id", default=None)

_NOISY_LOGGERS = (
    "httpx",
    "httpx2",
    "httpcore",
    "openai",
    "openai._base_client",
    "urllib3",
    "urllib3.connectionpool",
    "uvicorn.access",
    "multipart",
)


def bind_job(job_id: str | None) -> None:
    if job_id:
        job_id_var.set(str(job_id))


def garment_name(garment: dict[str, Any] | None) -> str:
    if not isinstance(garment, dict):
        return "item"
    return str(garment.get("category") or garment.get("id") or "item")


class HumanFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        now = datetime.now().strftime("%H:%M:%S")
        if record.levelno >= logging.ERROR:
            tag = "ERROR  "
        elif record.levelno >= logging.WARNING:
            tag = "WARN   "
        else:
            tag = ""
        job = job_id_var.get()
        job_bit = f"Job {job.replace('-', '')[:8]}  " if job else ""
        line = f"{now}  {tag}{job_bit}{record.getMessage()}"
        if record.exc_info:
            line += "\n" + self.formatException(record.exc_info)
        return line


def agent_log(hypothesis_id: str, location: str, message: str, data: dict[str, Any] | None = None) -> None:
    # #region agent log
    try:
        import json
        import time

        with open("/Users/mehrabzk/HTN2026/.cursor/debug-b95844.log", "a", encoding="utf-8") as handle:
            handle.write(
                json.dumps(
                    {
                        "sessionId": "b95844",
                        "runId": "stage1-audit",
                        "hypothesisId": hypothesis_id,
                        "location": location,
                        "message": message,
                        "data": data or {},
                        "timestamp": int(time.time() * 1000),
                    }
                )
                + "\n"
            )
    except Exception:
        pass
    # #endregion


def configure_logging() -> None:
    level_name = os.getenv("LOG_LEVEL", "INFO").upper()
    level = getattr(logging, level_name, logging.INFO)
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(HumanFormatter())
    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(level)
    for name in _NOISY_LOGGERS:
        logging.getLogger(name).setLevel(logging.WARNING)
