import Fastify from "fastify";
import client from "prom-client";

const SERVICE_NAME = process.env.SERVICE_NAME ?? "api-gateway";
const ANNOUNCEMENT_SERVICE_URL =
  process.env.ANNOUNCEMENT_SERVICE_URL ?? "http://localhost:8081";

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

app.get("/ready", async (_, reply) => {
  try {
    const res = await fetch(`${ANNOUNCEMENT_SERVICE_URL}/ready`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      return reply.code(503).send({ status: "not_ready" });
    }
    return { status: "ready" };
  } catch (err) {
    app.log.error({ err }, "gateway readiness failed");
    return reply.code(503).send({ status: "not_ready" });
  }
});

app.get("/metrics", async (_, reply) => {
  reply.header("content-type", registry.contentType);
  return registry.metrics();
});

type MediaInput = {
  fileName?: string;
  contentType?: string;
  sizeBytes?: number;
};

type CreateBody = {
  title?: string;
  body?: string;
  targetGroup?: string;
  media?: MediaInput;
};

function forwardTraceHeaders(request: { headers: Record<string, unknown> }) {
  const out: Record<string, string> = {};
  const traceparent = request.headers["traceparent"];
  const tracestate = request.headers["tracestate"];
  if (typeof traceparent === "string") out.traceparent = traceparent;
  if (typeof tracestate === "string") out.tracestate = tracestate;
  return out;
}

app.post<{ Body: CreateBody }>("/announcements", async (request, reply) => {
  const { title, body, targetGroup, media } = request.body ?? {};
  if (!title || !body || !targetGroup) {
    return reply.code(400).send({ error: "invalid_payload" });
  }

  const upstream = await fetch(`${ANNOUNCEMENT_SERVICE_URL}/internal/announcements`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...forwardTraceHeaders(request),
    },
    body: JSON.stringify({ title, body, targetGroup, media }),
  });

  const text = await upstream.text();
  const contentType = upstream.headers.get("content-type") ?? "application/json";
  reply.code(upstream.status).header("content-type", contentType);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
});

const port = Number(process.env.PORT ?? 8080);
const host = "0.0.0.0";

app.listen({ port, host }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
