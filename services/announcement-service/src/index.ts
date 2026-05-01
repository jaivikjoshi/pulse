import Fastify from "fastify";
import pg from "pg";
import client from "prom-client";

const SERVICE_NAME = process.env.SERVICE_NAME ?? "announcement-service";
const DATABASE_URL = process.env.DATABASE_URL;
const MEDIA_SERVICE_URL = process.env.MEDIA_SERVICE_URL ?? "http://localhost:8082";
const NOTIFICATION_SERVICE_URL =
  process.env.NOTIFICATION_SERVICE_URL ?? "http://localhost:8083";

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

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

const announcementCreated = new client.Counter({
  name: "announcement_created_total",
  help: "Announcements successfully created",
  labelNames: ["service"],
  registers: [registry],
});

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS announcements (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      target_group TEXT NOT NULL,
      media_url TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function waitForSchema(maxAttempts = 30) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await ensureSchema();
      return;
    } catch (err) {
      app.log.warn({ err, attempt, maxAttempts }, "waiting for database");
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  throw new Error("database did not become ready before startup timeout");
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

app.get("/ready", async (_, reply) => {
  try {
    await pool.query("SELECT 1");
    return { status: "ready" };
  } catch (err) {
    app.log.error({ err }, "readiness check failed");
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

async function processMedia(
  media: MediaInput,
  traceHeaders: Record<string, string>,
): Promise<string | null> {
  const res = await fetch(`${MEDIA_SERVICE_URL}/internal/media/process`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...traceHeaders,
    },
    body: JSON.stringify({
      fileName: media.fileName,
      contentType: media.contentType,
      sizeBytes: media.sizeBytes,
    }),
  });
  if (!res.ok) {
    throw new Error(`media_service_${res.status}`);
  }
  const data = (await res.json()) as { mediaUrl?: string };
  return data.mediaUrl ?? null;
}

async function notify(
  announcementId: string,
  targetGroup: string,
  traceHeaders: Record<string, string>,
): Promise<void> {
  const res = await fetch(`${NOTIFICATION_SERVICE_URL}/internal/notify`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...traceHeaders,
    },
    body: JSON.stringify({ announcementId, targetGroup }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`notification_service_${res.status}:${text}`);
  }
}

function forwardTraceHeaders(request: { headers: Record<string, unknown> }) {
  const out: Record<string, string> = {};
  const traceparent = request.headers["traceparent"];
  const tracestate = request.headers["tracestate"];
  if (typeof traceparent === "string") out.traceparent = traceparent;
  if (typeof tracestate === "string") out.tracestate = tracestate;
  return out;
}

app.post<{ Body: CreateBody }>("/internal/announcements", async (request, reply) => {
  const { title, body, targetGroup, media } = request.body ?? {};
  if (!title || !body || !targetGroup) {
    return reply.code(400).send({ error: "invalid_payload" });
  }

  const traceHeaders = forwardTraceHeaders(request);
  let mediaUrl: string | null = null;

  if (media && (media.contentType || media.fileName)) {
    try {
      mediaUrl = await processMedia(
        {
          fileName: media.fileName,
          contentType: media.contentType,
          sizeBytes: media.sizeBytes,
        },
        traceHeaders,
      );
    } catch (err) {
      app.log.warn({ err }, "media processing failed");
      return reply.code(502).send({ error: "media_processing_failed" });
    }
  }

  const insert = await pool.query<{ id: string }>(
    `INSERT INTO announcements (title, body, target_group, media_url)
     VALUES ($1, $2, $3, $4)
     RETURNING id::text AS id`,
    [title, body, targetGroup, mediaUrl],
  );
  const id = insert.rows[0]?.id;
  if (!id) {
    return reply.code(500).send({ error: "persist_failed" });
  }

  try {
    await notify(id, targetGroup, traceHeaders);
  } catch (err) {
    app.log.warn({ err }, "notification failed after persist");
    return reply.code(201).send({
      id,
      status: "created_notify_failed",
      message: "Announcement saved but notification delivery failed",
    });
  }

  announcementCreated.inc({ service: SERVICE_NAME });
  return reply.code(201).send({ id, status: "created", mediaUrl });
});

app.get<{ Params: { id: string } }>("/announcements/:id", async (request, reply) => {
  const { id } = request.params;
  const result = await pool.query(
    `SELECT id::text AS id, title, body, target_group AS "targetGroup",
            media_url AS "mediaUrl", created_at AS "createdAt"
     FROM announcements WHERE id = $1::uuid`,
    [id],
  );
  if (result.rowCount === 0) {
    return reply.code(404).send({ error: "not_found" });
  }
  return result.rows[0];
});

const port = Number(process.env.PORT ?? 8080);
const host = "0.0.0.0";

async function main() {
  await waitForSchema();
  await app.listen({ port, host });
}

main().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
