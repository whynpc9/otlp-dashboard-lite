import type { FastifyInstance } from "fastify";
import type { TelemetryStore } from "../store/types.js";

export function registerApiRoutes(app: FastifyInstance, store: TelemetryStore) {
  app.get("/api/health", async () => ({
    ok: true,
    service: "Local OTel Workbench",
    ...store.stats()
  }));

  app.get("/api/resources", async () => ({
    resources: store.listResources()
  }));

  app.get("/api/traces", async (request) => {
    const query = request.query as Record<string, string | undefined>;
    const page = pageQuery(query);
    const traces = store.listTraces({
      service: query.service || undefined,
      q: query.q || undefined,
      hasError: parseBoolean(query.hasError),
      minDurationMs: query.minDurationMs ? Number(query.minDurationMs) : undefined,
      fromUnixNano: parseTimeUnixNano(query.from),
      toUnixNano: parseTimeUnixNano(query.to),
      offset: page.offset,
      limit: page.limit + 1
    });
    return {
      traces: traces.slice(0, page.limit),
      nextCursor: traces.length > page.limit ? String(page.offset + page.limit) : undefined
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
    const page = pageQuery(query);
    const logs = store.listLogs({
      service: query.service || undefined,
      severity: query.severity || undefined,
      traceId: query.traceId || undefined,
      spanId: query.spanId || undefined,
      q: query.q || undefined,
      fromUnixNano: parseTimeUnixNano(query.from),
      toUnixNano: parseTimeUnixNano(query.to),
      offset: page.offset,
      limit: page.limit + 1
    });
    return {
      logs: logs.slice(0, page.limit),
      nextCursor: logs.length > page.limit ? String(page.offset + page.limit) : undefined
    };
  });

  app.get("/api/metrics", async (request) => {
    const query = request.query as Record<string, string | undefined>;
    const page = pageQuery(query);
    const metrics = store.listMetrics({
      service: query.service || undefined,
      q: query.q || undefined,
      fromUnixNano: parseTimeUnixNano(query.from),
      toUnixNano: parseTimeUnixNano(query.to),
      offset: page.offset,
      limit: page.limit + 1
    });
    return {
      metrics: metrics.slice(0, page.limit),
      nextCursor: metrics.length > page.limit ? String(page.offset + page.limit) : undefined
    };
  });

  app.get("/api/metrics/:name/series", async (request) => {
    const { name } = request.params as { name: string };
    const query = request.query as Record<string, string | undefined>;
    const page = pageQuery(query);
    const series = store.getMetricSeries({
      metricName: name,
      service: query.service || undefined,
      meterName: query.meterName || undefined,
      attrs: query.attrs || undefined,
      fromUnixNano: parseTimeUnixNano(query.from),
      toUnixNano: parseTimeUnixNano(query.to),
      offset: page.offset,
      limit: page.limit + 1
    });
    return {
      series: series.slice(0, page.limit),
      nextCursor: series.length > page.limit ? String(page.offset + page.limit) : undefined
    };
  });

  app.get("/api/genai/traces", async (request) => {
    const query = request.query as Record<string, string | undefined>;
    const page = pageQuery(query);
    return {
      traces: store.listGenAiTraces({
        service: query.service || undefined,
        q: query.q || undefined,
        fromUnixNano: parseTimeUnixNano(query.from),
        toUnixNano: parseTimeUnixNano(query.to),
        offset: page.offset,
        limit: page.limit
      })
    };
  });

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
    const body = (request.body ?? {}) as { maxAgeMs?: number; maxTraces?: number; maxLogs?: number; maxMetrics?: number; maxDbSizeBytes?: number };
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

function pageQuery(query: Record<string, string | undefined>) {
  return {
    limit: clampLimit(query.limit),
    offset: Math.max(0, Number(query.cursor ?? 0) || 0)
  };
}

function parseTimeUnixNano(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (/^\d+$/.test(value)) {
    const numeric = BigInt(value);
    return value.length > 16 ? String(numeric) : String(numeric * 1_000_000n);
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) {
    return undefined;
  }
  return String(BigInt(millis) * 1_000_000n);
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  return value === "true" || value === "1";
}
