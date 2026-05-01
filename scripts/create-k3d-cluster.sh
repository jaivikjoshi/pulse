#!/usr/bin/env bash
set -euo pipefail

CLUSTER_NAME="${CLUSTER_NAME:-pulseops}"

if k3d cluster list "$CLUSTER_NAME" >/dev/null 2>&1; then
  echo "k3d cluster '$CLUSTER_NAME' already exists"
  exit 0
fi

k3d cluster create "$CLUSTER_NAME" \
  --agents 1 \
  --port "8088:30080@loadbalancer" \
  --wait

kubectl config use-context "k3d-$CLUSTER_NAME"
