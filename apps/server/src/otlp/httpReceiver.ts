import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { gunzipSync } from "node:zlib";
import { normalizeOtlpBatch } from "../ingest/normalize.js";
import type { OtlpProtocol, RetentionPolicy, TelemetrySignal, TelemetryStore } from "../store/types.js";

type RawBody = Buffer;

export function registerOtlpRoutes(app: FastifyInstance, store: TelemetryStore, retention: RetentionPolicy = {}) {
  app.addContentTypeParser("application/x-protobuf", { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });

  app.post("/v1/traces", async (request, reply) => handleOtlp(request, reply, store, retention, "traces"));
  app.post("/v1/logs", async (request, reply) => handleOtlp(request, reply, store, retention, "logs"));
  app.post("/v1/metrics", async (request, reply) => handleOtlp(request, reply, store, retention, "metrics"));
}

async function handleOtlp(
  request: FastifyRequest,
  reply: FastifyReply,
  store: TelemetryStore,
  retention: RetentionPolicy,
  signal: TelemetrySignal
) {
  const contentType = String(request.headers["content-type"] ?? "application/json").split(";")[0]!.trim().toLowerCase();
  const contentEncoding = String(request.headers["content-encoding"] ?? "").toLowerCase() || undefined;
  const protocol = protocolFromContentType(contentType);

  if (!protocol) {
    return reply.code(415).send({ error: `Unsupported content type ${contentType}` });
  }

  try {
    const body = decodeBody(request.body as RawBody, protocol, contentEncoding);
    const parsed = protocol === "http/json" ? body.parsed : undefined;
    const batch = normalizeOtlpBatch({
      signal,
      protocol,
      receivedAt: Date.now(),
      contentType,
      contentEncoding,
      body: body.raw,
      parsed
    });
    store.ingest(batch);
    store.enforceRetention(retention);

    if (protocol === "http/protobuf") {
      return reply.header("content-type", "application/x-protobuf").send(Buffer.alloc(0));
    }
    return reply.send({});
  } catch (error) {
    return reply.code(400).send({
      error: error instanceof Error ? error.message : "Invalid OTLP request"
    });
  }
}

function protocolFromContentType(contentType: string): OtlpProtocol | undefined {
  if (contentType === "application/x-protobuf") {
    return "http/protobuf";
  }
  if (contentType === "application/json") {
    return "http/json";
  }
  return undefined;
}

function decodeBody(body: RawBody, protocol: OtlpProtocol, contentEncoding?: string): { raw: Buffer; parsed?: unknown } {
  if (protocol === "http/json") {
    if (!Buffer.isBuffer(body)) {
      throw new Error("Expected JSON payload as raw bytes");
    }
    const raw = contentEncoding === "gzip" ? gunzipSync(body) : body;
    const text = raw.toString("utf8");
    return { raw, parsed: text ? JSON.parse(text) : {} };
  }

  if (!Buffer.isBuffer(body)) {
    throw new Error("Expected protobuf payload as raw bytes");
  }

  const raw = contentEncoding === "gzip" ? gunzipSync(body) : body;
  return { raw };
}
