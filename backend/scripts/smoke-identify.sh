#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${BACKEND_PORT:-4000}"
BASE="http://127.0.0.1:${PORT}"
IMG="${1:-$ROOT/scripts/fixtures/sample.jpg}"

if [[ ! -f "$IMG" ]]; then
  echo "Missing sample image: $IMG" >&2
  exit 1
fi

echo "POST $BASE/api/identify  ($IMG)"
CREATE="$(curl -sS -F "image=@${IMG}" -F "type=image" -F "origin=app" "$BASE/api/identify")"
echo "$CREATE"

JOB_ID="$(node -e "const r=JSON.parse(process.argv[1]); if (!r.job_id) process.exit(1); process.stdout.write(r.job_id)" "$CREATE")"

echo
echo "Polling GET $BASE/jobs/$JOB_ID"
POLL=""
for _ in $(seq 1 60); do
  POLL="$(curl -sS "$BASE/jobs/$JOB_ID")"
  STATUS="$(node -e "process.stdout.write(JSON.parse(process.argv[1]).status || '')" "$POLL")"
  echo "  status=$STATUS"
  if [[ "$STATUS" == "done" || "$STATUS" == "error" ]]; then
    break
  fi
  sleep 0.4
done

echo "$POLL"

node -e "
const result = JSON.parse(process.argv[1]);
if (result.status === 'error') {
  console.error('Job error:', result.error || '(none)');
  process.exit(1);
}
if (result.status !== 'done') {
  console.error('Expected status done, got', result.status);
  process.exit(1);
}
if (!Array.isArray(result.items)) {
  console.error('Expected items[]');
  process.exit(1);
}
console.error('OK job_id=' + result.job_id + ' items=' + result.items.length);
" "$POLL"
