import Fastify from "fastify";
import client from "prom-client";

const SERVICE_NAME = process.env.SERVICE_NAME ?? "notification-service";

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

const notificationSent = new client.Counter({
  name: "notification_sent_total",
  help: "Notifications sent successfully",
  labelNames: ["service"],
  registers: [registry],
});

const notificationFailed = new client.Counter({
  name: "notification_failed_total",
  help: "Notification failures",
  labelNames: ["service", "reason"],
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

app.get("/ready", async () => ({ status: "ready" }));

app.get("/metrics", async (_, reply) => {
  reply.header("content-type", registry.contentType);
  return registry.metrics();
});

type NotifyBody = {
  announcementId?: string;
  targetGroup?: string;
};

app.post<{ Body: NotifyBody; Querystring: { forceFail?: string } }>(
  "/internal/notify",
  async (request, reply) => {
    const { announcementId, targetGroup } = request.body ?? {};
    if (!announcementId || !targetGroup) {
      notificationFailed.inc({
        service: SERVICE_NAME,
        reason: "validation",
      });
      return reply.code(400).send({ error: "invalid_payload" });
    }

    const forceFail = request.query.forceFail === "1";
    await new Promise((r) => setTimeout(r, 15 + Math.floor(Math.random() * 40)));

    if (forceFail || Math.random() < 0.03) {
      notificationFailed.inc({
        service: SERVICE_NAME,
        reason: "downstream",
      });
      return reply.code(503).send({ status: "failed", announcementId });
    }

    notificationSent.inc({ service: SERVICE_NAME });
    return { status: "sent", announcementId };
  },
);

const port = Number(process.env.PORT ?? 8080);
const host = "0.0.0.0";

app.listen({ port, host }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
