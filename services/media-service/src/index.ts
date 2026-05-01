import Fastify from "fastify";
import client from "prom-client";

const SERVICE_NAME = process.env.SERVICE_NAME ?? "media-service";
const FAILURE_RATE_PERCENT = Math.min(
  100,
  Math.max(0, Number(process.env.FAILURE_RATE_PERCENT ?? "0") || 0),
);

const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: "pulseops_" });

const httpRequests = new client.Counter({
  name: "http_requests_total",
  help: "HTTP requests",
  labelNames: ["service", "method", "route", "status"],
  registers: [registry],
});

const httpDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration",
  labelNames: ["service", "method", "route", "status"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry],
});

const mediaProcessingDuration = new client.Histogram({
  name: "media_processing_duration_seconds",
  help: "Simulated media processing duration",
  labelNames: ["service"],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2],
  registers: [registry],
});

const mediaFailed = new client.Counter({
  name: "media_processing_failed_total",
  help: "Media processing failures",
  labelNames: ["service", "reason"],
  registers: [registry],
});

const allowedTypes = new Set(["image/png", "image/jpeg", "application/pdf"]);
const maxBytes = 10 * 1024 * 1024;

function shouldSimulateFailure(): boolean {
  if (FAILURE_RATE_PERCENT <= 0) return false;
  return Math.random() * 100 < FAILURE_RATE_PERCENT;
}

const app = Fastify({ logger: true });

app.addHook("onResponse", (request, reply, done) => {
  const route = request.routeOptions.url ?? request.url;
  const labels = {
    service: SERVICE_NAME,
    method: request.method,
    route,
    status: String(reply.statusCode),
  };
  httpRequests.inc(labels);
  const rt = reply.getResponseTime() / 1000;
  httpDuration.observe(labels, rt);
  done();
});

app.get("/healthz", async () => ({ status: "ok" }));

let ready = true;
app.get("/ready", async (_, reply) => {
  if (!ready) {
    return reply.code(503).send({ status: "not_ready" });
  }
  return { status: "ready" };
});

app.get("/metrics", async (_, reply) => {
  reply.header("content-type", registry.contentType);
  return registry.metrics();
});

type ProcessBody = {
  fileName?: string;
  contentType?: string;
  sizeBytes?: number;
};

app.post<{ Body: ProcessBody; Querystring: { fail?: string } }>(
  "/internal/media/process",
  async (request, reply) => {
    const forceFail = request.query.fail === "1" || request.query.fail === "true";
    const headerFail = request.headers["x-simulate-media-failure"] === "true";

    if (forceFail || headerFail || shouldSimulateFailure()) {
      mediaFailed.inc({ service: SERVICE_NAME, reason: "simulated" });
      return reply.code(500).send({ error: "media_processing_failed" });
    }

    const body = request.body ?? {};
    const contentType = body.contentType;
    const size = Number(body.sizeBytes ?? 0);

    if (!contentType || !allowedTypes.has(contentType)) {
      mediaFailed.inc({ service: SERVICE_NAME, reason: "invalid_type" });
      return reply.code(400).send({ error: "invalid_media_type" });
    }
    if (!Number.isFinite(size) || size <= 0 || size > maxBytes) {
      mediaFailed.inc({ service: SERVICE_NAME, reason: "invalid_size" });
      return reply.code(400).send({ error: "invalid_media_size" });
    }

    const endTimer = mediaProcessingDuration.startTimer({ service: SERVICE_NAME });
    const delayMs = Math.min(800, 40 + Math.floor(Math.random() * 120));
    await new Promise((r) => setTimeout(r, delayMs));
    endTimer();

    const mockUrl = `https://media.pulseops.local/mock/${encodeURIComponent(body.fileName ?? "file")}`;
    return { mediaUrl: mockUrl, processingMs: delayMs };
  },
);

const port = Number(process.env.PORT ?? 8080);
const host = "0.0.0.0";

app.listen({ port, host }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
