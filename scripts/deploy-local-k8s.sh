#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLUSTER_NAME="${CLUSTER_NAME:-pulseops}"

cd "$ROOT_DIR"

docker compose build api-gateway announcement-service media-service notification-service

k3d image import \
  pulse-api-gateway:latest \
  pulse-announcement-service:latest \
  pulse-media-service:latest \
  pulse-notification-service:latest \
  --cluster "$CLUSTER_NAME"

kubectl apply -k k8s/overlays/local

kubectl -n pulseops rollout restart \
  deployment/api-gateway \
  deployment/announcement-service \
  deployment/media-service \
  deployment/notification-service

kubectl -n pulseops rollout status deployment/postgres --timeout=180s
kubectl -n pulseops rollout status deployment/media-service --timeout=180s
kubectl -n pulseops rollout status deployment/notification-service --timeout=180s
kubectl -n pulseops rollout status deployment/announcement-service --timeout=180s
kubectl -n pulseops rollout status deployment/api-gateway --timeout=180s

kubectl -n pulseops get pods,svc,hpa
