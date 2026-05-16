import type { FastifyInstance } from "fastify";
import type { TelemetryStore } from "../store/types.js";

export function registerApiRoutes(app: FastifyInstance, store: TelemetryStore) {
  app.get("/api/health", async () => ({
    ok: true,
    service: "Local OTLP Workbench",
    ...store.stats()
  }));

  app.get("/api/resources", async () => ({
    resources: store.listResources()
  }));

  app.get("/api/traces", async (request) => {
    const query = request.query as Record<string, string | undefined>;
    return {
      traces: store.listTraces({
        service: query.service || undefined,
        q: query.q || undefined,
        hasError: parseBoolean(query.hasError),
        minDurationMs: query.minDurationMs ? Number(query.minDurationMs) : undefined,
        limit: clampLimit(query.limit)
      })
    };
  });

  app.get("/api/traces/:traceId", async (request, reply) => {
    const { traceId } = request.params as { traceId: string };
    const trace = store.getTrace(traceId);
    if (!trace) {
      return reply.code(404).send({ error: "Trace not found" });
    }
    return { trace };
  });

  app.get("/api/logs", async (request) => {
    const query = request.query as Record<string, string | undefined>;
    return {
      logs: store.listLogs({
        service: query.service || undefined,
        severity: query.severity || undefined,
        traceId: query.traceId || undefined,
        spanId: query.spanId || undefined,
        q: query.q || undefined,
        limit: clampLimit(query.limit)
      })
    };
  });

  app.get("/api/metrics", async (request) => {
    const query = request.query as Record<string, string | undefined>;
    return {
      metrics: store.listMetrics({
        service: query.service || undefined,
        q: query.q || undefined,
        limit: clampLimit(query.limit)
      })
    };
  });

  app.get("/api/metrics/:name/series", async (request) => {
    const { name } = request.params as { name: string };
    const query = request.query as Record<string, string | undefined>;
    return {
      series: store.getMetricSeries({
        metricName: name,
        service: query.service || undefined,
        attrs: query.attrs || undefined,
        limit: clampLimit(query.limit)
      })
    };
  });

  app.get("/api/genai/traces", async () => ({
    traces: store.listGenAiTraces()
  }));

  app.get("/api/genai/traces/:traceId", async (request, reply) => {
    const { traceId } = request.params as { traceId: string };
    const trace = store.getTrace(traceId);
    if (!trace) {
      return reply.code(404).send({ error: "Trace not found" });
    }
    return {
      traceId: trace.traceId,
      rootName: trace.rootName,
      serviceNames: trace.serviceNames,
      durationNano: trace.durationNano,
      errorCount: trace.errorCount,
      genAi: trace.genAi
    };
  });

  app.post("/api/export", async () => store.exportData());

  app.post("/api/import", async (request) => store.importData(request.body));

  app.post("/api/retention", async (request) => {
    const body = (request.body ?? {}) as { maxAgeMs?: number; maxTraces?: number; maxLogs?: number; maxMetrics?: number };
    return store.enforceRetention(body);
  });

  app.delete("/api/data", async () => {
    store.clear();
    return { ok: true };
  });
}

function clampLimit(value: string | undefined) {
  const parsed = Number(value ?? 100);
  if (!Number.isFinite(parsed)) {
    return 100;
  }
  return Math.max(1, Math.min(500, parsed));
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  return value === "true" || value === "1";
}
