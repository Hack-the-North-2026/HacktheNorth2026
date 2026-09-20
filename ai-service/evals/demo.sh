#!/usr/bin/env bash
# Demo script: one known-good screenshot through the Stage 1 identify job.
# Usage: ./evals/demo.sh [path/to/fit-check.jpg]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${BACKEND_PORT:-4000}"
IMG="${1:-}"

if [[ -z "$IMG" ]]; then
  echo "Usage: $0 path/to/known-good-screenshot.jpg" >&2
  echo "Demo line: Lens showed similar outfits. We cropped the jacket, searched every Shopify merchant plus the open web, and confirmed the product photo against the chip." >&2
  exit 2
fi

exec bash "$ROOT/backend/scripts/smoke-identify.sh" "$IMG"
