#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v helm >/dev/null 2>&1; then
  echo "Helm is required. Install it with: brew install helm"
  exit 1
fi

kubectl create namespace observability --dry-run=client -o yaml | kubectl apply -f -

helm repo add prometheus-community https://prometheus-community.github.io/helm-charts >/dev/null
helm repo update prometheus-community

helm upgrade --install kube-prometheus-stack prometheus-community/kube-prometheus-stack \
  --namespace observability \
  --values "$ROOT_DIR/observability/prometheus/kube-prometheus-stack-values.yaml" \
  --wait \
  --timeout 10m

kubectl apply -f "$ROOT_DIR/observability/prometheus/service-monitors.yaml"
kubectl apply -f "$ROOT_DIR/observability/grafana/dashboards/pulseops-dashboard-configmap.yaml"

kubectl -n observability rollout status deployment/pulseops-observability-grafana --timeout=180s
kubectl -n observability rollout status statefulset/prometheus-pulseops-observability-prometheus --timeout=300s

kubectl -n observability get pods,svc

echo
echo "Grafana:"
echo "  kubectl -n observability port-forward svc/pulseops-observability-grafana 3000:80"
echo "  open http://localhost:3000"
echo "  username: admin"
echo "  password: pulseops"
echo
echo "Prometheus:"
echo "  kubectl -n observability port-forward svc/pulseops-observability-prometheus 9090:9090"
echo "  open http://localhost:9090/targets"
