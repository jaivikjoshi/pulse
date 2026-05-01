#!/usr/bin/env bash
set -euo pipefail
BASE="${GATEWAY_URL:-http://localhost:8080}"
curl -sfS "${BASE}/healthz" >/dev/null
curl -sfS "${BASE}/ready" >/dev/null
resp="$(curl -sfS "${BASE}/announcements" \
  -X POST \
  -H 'content-type: application/json' \
  -d '{"title":"Smoke","body":"Test","targetGroup":"all","media":{"fileName":"a.png","contentType":"image/png","sizeBytes":1024}}')"
echo "${resp}" | head -c 500
echo
