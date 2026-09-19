"""Structured, secret-conscious terminal logging for the AI service."""

from __future__ import annotations

import json
import logging
import os
import sys
from datetime import datetime, timezone
from typing import Any


_SECRET_KEYS = (
    "authorization",
    "api_key",
    "token",
    "secret",
    "password",
    "cookie",
    "base64",
    "buffer",
    "data",
)


def _sanitize(value: Any, depth: int = 0) -> Any:
    if depth > 4:
        return "[truncated]"
    if isinstance(value, dict):
        return {
            str(key): (
                "[redacted]"
                if any(secret in str(key).lower() for secret in _SECRET_KEYS)
                else _sanitize(item, depth + 1)
            )
            for key, item in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [_sanitize(item, depth + 1) for item in value[:20]]
    if isinstance(value, str) and len(value) > 2000:
        return value[:2000] + "..."
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        entry = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname.lower(),
            "service": "ai-service",
            "logger": record.name,
            "event": record.getMessage(),
        }
        context = getattr(record, "context", None)
        if context:
            entry.update(_sanitize(context))
        if record.exc_info:
            entry["exception"] = self.formatException(record.exc_info)
        return json.dumps(entry, ensure_ascii=True)


def configure_logging() -> None:
    level_name = os.getenv("LOG_LEVEL", "INFO").upper()
    level = getattr(logging, level_name, logging.INFO)
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(level)
