#!/usr/bin/env bash
set -euo pipefail

BASE="${GATEWAY_URL:-http://localhost:8088}"

curl -sfS "$BASE/healthz" >/dev/null
curl -sfS "$BASE/ready" >/dev/null

curl -sfS "$BASE/announcements" \
  -X POST \
  -H "content-type: application/json" \
  -d '{"title":"Kubernetes smoke","body":"Created through k3d","targetGroup":"platform","media":{"fileName":"k8s.png","contentType":"image/png","sizeBytes":2048}}'

echo
