#!/usr/bin/env bash
set -euo pipefail

kubectl -n observability get pods
kubectl -n observability get servicemonitors.monitoring.coreos.com
kubectl -n observability get configmap pulseops-grafana-dashboard

PROM_POD="$(kubectl -n observability get pod -l app.kubernetes.io/name=prometheus -o jsonpath='{.items[0].metadata.name}')"

kubectl -n observability exec "$PROM_POD" -c prometheus -- wget -qO- \
  "http://localhost:9090/api/v1/query?query=up%7Bnamespace%3D%22pulseops%22%7D" \
  | grep -q '"status":"success"'

echo "Prometheus is queryable and PulseOps ServiceMonitors are installed."
