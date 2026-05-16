import { nanoid } from "nanoid";
import type {
  GenAiTraceSummary,
  IngestBatch,
  IngestResult,
  LogQuery,
  MetricDescriptor,
  MetricQuery,
  MetricSeriesPoint,
  MetricSeriesQuery,
  NormalizedLogRecord,
  NormalizedMetricPoint,
  NormalizedSpan,
  RawOtlpBatch,
  RetentionPolicy,
  TraceDetail,
  TraceListQuery,
  TraceSummary,
  TelemetryStore
} from "./types.js";

export interface MemoryStoreLimits {
  maxSpans: number;
  maxLogs: number;
  maxBatches: number;
  maxMetrics?: number;
}

export class MemoryTelemetryStore implements TelemetryStore {
  private readonly limits: MemoryStoreLimits;
  private readonly batches: RawOtlpBatch[] = [];
  private readonly spans: NormalizedSpan[] = [];
  private readonly logs: NormalizedLogRecord[] = [];
  private readonly metrics: NormalizedMetricPoint[] = [];
  private summaries = new Map<string, TraceSummary>();

  constructor(limits: MemoryStoreLimits) {
    this.limits = limits;
  }

  ingest(batch: IngestBatch): IngestResult {
    this.batches.push(batch.raw);
    this.spans.push(...batch.spans);
    this.logs.push(...batch.logs);
    this.metrics.push(...batch.metrics);

    trimStart(this.batches, this.limits.maxBatches);
    trimStart(this.spans, this.limits.maxSpans);
    trimStart(this.logs, this.limits.maxLogs);
    trimStart(this.metrics, this.limits.maxMetrics ?? 100_000);

    this.rebuildTraceSummaries();

    return {
      accepted: batch.spans.length + batch.logs.length + batch.metrics.length,
      rejected: 0,
      warnings: []
    };
  }

  listResources() {
    const resources = new Map<string, { serviceName: string; spanCount: number; logCount: number; lastSeen: number }>();

    for (const span of this.spans) {
      const item = resources.get(span.serviceName) ?? {
        serviceName: span.serviceName,
        spanCount: 0,
        logCount: 0,
        lastSeen: 0
      };
      item.spanCount += 1;
      item.lastSeen = Math.max(item.lastSeen, Number(span.endTimeUnixNano) / 1_000_000);
      resources.set(span.serviceName, item);
    }

    for (const log of this.logs) {
      const item = resources.get(log.serviceName) ?? {
        serviceName: log.serviceName,
        spanCount: 0,
        logCount: 0,
        lastSeen: 0
      };
      item.logCount += 1;
      item.lastSeen = Math.max(item.lastSeen, Number(log.timeUnixNano ?? log.observedTimeUnixNano ?? 0) / 1_000_000);
      resources.set(log.serviceName, item);
    }

    for (const metric of this.metrics) {
      const item = resources.get(metric.serviceName) ?? {
        serviceName: metric.serviceName,
        spanCount: 0,
        logCount: 0,
        lastSeen: 0
      };
      item.lastSeen = Math.max(item.lastSeen, Number(metric.timeUnixNano) / 1_000_000);
      resources.set(metric.serviceName, item);
    }

    return [...resources.values()].sort((a, b) => b.lastSeen - a.lastSeen);
  }

  listTraces(query: TraceListQuery): TraceSummary[] {
    let rows = [...this.summaries.values()];

    if (query.service) {
      rows = rows.filter((trace) => trace.serviceNames.includes(query.service!));
    }
    if (query.hasError !== undefined) {
      rows = rows.filter((trace) => (trace.errorCount > 0) === query.hasError);
    }
    if (query.minDurationMs !== undefined) {
      rows = rows.filter((trace) => trace.durationNano >= query.minDurationMs! * 1_000_000);
    }
    if (query.q) {
      const q = query.q.toLowerCase();
      rows = rows.filter((trace) => trace.rootName.toLowerCase().includes(q) || trace.traceId.includes(q));
    }

    return rows
      .sort((a, b) => Number(b.startTimeUnixNano) - Number(a.startTimeUnixNano))
      .slice(0, query.limit);
  }

  getTrace(traceId: string): TraceDetail | undefined {
    const summary = this.summaries.get(traceId);
    if (!summary) {
      return undefined;
    }

    const spans = this.spans
      .filter((span) => span.traceId === traceId)
      .sort((a, b) => Number(a.startTimeUnixNano) - Number(b.startTimeUnixNano));
    const logs = this.logs
      .filter((log) => log.traceId === traceId)
      .sort((a, b) => Number(a.timeUnixNano ?? a.observedTimeUnixNano ?? 0) - Number(b.timeUnixNano ?? b.observedTimeUnixNano ?? 0));

    return {
      ...summary,
      spans,
      logs,
      genAi: summarizeGenAi(spans)
    };
  }

  listLogs(query: LogQuery): NormalizedLogRecord[] {
    let rows = [...this.logs];

    if (query.service) {
      rows = rows.filter((log) => log.serviceName === query.service);
    }
    if (query.traceId) {
      rows = rows.filter((log) => log.traceId === query.traceId);
    }
    if (query.spanId) {
      rows = rows.filter((log) => log.spanId === query.spanId);
    }
    if (query.severity) {
      rows = rows.filter((log) => (log.severityText ?? "").toLowerCase().includes(query.severity!.toLowerCase()));
    }
    if (query.q) {
      const q = query.q.toLowerCase();
      rows = rows.filter((log) => {
        return (
          (log.bodyText ?? "").toLowerCase().includes(q) ||
          JSON.stringify(log.attributes).toLowerCase().includes(q)
        );
      });
    }

    return rows
      .sort((a, b) => Number(b.timeUnixNano ?? b.observedTimeUnixNano ?? 0) - Number(a.timeUnixNano ?? a.observedTimeUnixNano ?? 0))
      .slice(0, query.limit);
  }

  listMetrics(query: MetricQuery): MetricDescriptor[] {
    const grouped = new Map<string, MetricDescriptor & { attrs: Set<string> }>();
    for (const point of this.metrics) {
      if (query.service && point.serviceName !== query.service) {
        continue;
      }
      if (query.q && !point.metricName.toLowerCase().includes(query.q.toLowerCase())) {
        continue;
      }

      const key = `${point.serviceName}\n${point.meterName}\n${point.metricName}`;
      const current = grouped.get(key) ?? {
        serviceName: point.serviceName,
        meterName: point.meterName,
        metricName: point.metricName,
        metricType: point.metricType,
        description: point.description,
        unit: point.unit,
        pointCount: 0,
        lastSeen: 0,
        attributeSets: 0,
        attrs: new Set<string>()
      };
      current.pointCount += 1;
      current.lastSeen = Math.max(current.lastSeen, Number(point.timeUnixNano) / 1_000_000);
      current.attrs.add(point.attributesHash);
      current.attributeSets = current.attrs.size;
      grouped.set(key, current);
    }

    return [...grouped.values()]
      .map(({ attrs: _attrs, ...item }) => item)
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .slice(0, query.limit);
  }

  getMetricSeries(query: MetricSeriesQuery): MetricSeriesPoint[] {
    return this.metrics
      .filter((point) => point.metricName === query.metricName)
      .filter((point) => !query.service || point.serviceName === query.service)
      .filter((point) => !query.attrs || point.attributesHash === query.attrs)
      .sort((a, b) => Number(a.timeUnixNano) - Number(b.timeUnixNano))
      .slice(-query.limit)
      .map((point) => ({
        timeUnixNano: point.timeUnixNano,
        value: point.value,
        count: point.count,
        sum: point.sum,
        min: point.min,
        max: point.max,
        attributes: point.attributes
      }));
  }

  listGenAiTraces(): TraceSummary[] {
    return this.listTraces({ limit: 100 })
      .filter((trace) => trace.genAiSpanCount > 0);
  }

  exportData() {
    return {
      exportedAt: new Date().toISOString(),
      batches: this.batches,
      spans: this.spans,
      logs: this.logs,
      metrics: this.metrics,
      traces: [...this.summaries.values()]
    };
  }

  importData(data: unknown) {
    const payload = data as Partial<{
      batches: RawOtlpBatch[];
      spans: NormalizedSpan[];
      logs: NormalizedLogRecord[];
      metrics: NormalizedMetricPoint[];
    }>;
    this.batches.push(...payload.batches ?? []);
    this.spans.push(...payload.spans ?? []);
    this.logs.push(...payload.logs ?? []);
    this.metrics.push(...payload.metrics ?? []);
    this.rebuildTraceSummaries();
    return { imported: (payload.spans?.length ?? 0) + (payload.logs?.length ?? 0) + (payload.metrics?.length ?? 0) };
  }

  enforceRetention(policy: RetentionPolicy) {
    const before = this.spans.length + this.logs.length + this.metrics.length;
    if (policy.maxAgeMs) {
      const minNano = String(BigInt(Math.floor((Date.now() - policy.maxAgeMs) * 1_000_000)));
      removeWhere(this.spans, (span) => span.endTimeUnixNano < minNano);
      removeWhere(this.logs, (log) => (log.timeUnixNano ?? log.observedTimeUnixNano ?? "0") < minNano);
      removeWhere(this.metrics, (metric) => metric.timeUnixNano < minNano);
    }
    trimStart(this.logs, policy.maxLogs ?? this.limits.maxLogs);
    trimStart(this.metrics, policy.maxMetrics ?? this.limits.maxMetrics ?? 100_000);
    if (policy.maxTraces !== undefined) {
      const keepTraceIds = new Set(this.listTraces({ limit: policy.maxTraces }).map((trace) => trace.traceId));
      removeWhere(this.spans, (span) => !keepTraceIds.has(span.traceId));
      removeWhere(this.logs, (log) => Boolean(log.traceId) && !keepTraceIds.has(log.traceId!));
    }
    this.rebuildTraceSummaries();
    const after = this.spans.length + this.logs.length + this.metrics.length;
    return { deleted: Math.max(0, before - after) };
  }

  clear() {
    this.batches.length = 0;
    this.spans.length = 0;
    this.logs.length = 0;
    this.metrics.length = 0;
    this.summaries = new Map();
  }

  stats() {
    return {
      batches: this.batches.length,
      spans: this.spans.length,
      logs: this.logs.length,
      traces: this.summaries.size,
      metrics: this.metrics.length,
      storage: "memory"
    };
  }

  nextLogId() {
    return nanoid(12);
  }

  private rebuildTraceSummaries() {
    const traces = new Map<string, NormalizedSpan[]>();
    for (const span of this.spans) {
      const group = traces.get(span.traceId) ?? [];
      group.push(span);
      traces.set(span.traceId, group);
    }

    const summaries = new Map<string, TraceSummary>();
    for (const [traceId, spans] of traces) {
      const ordered = [...spans].sort((a, b) => Number(a.startTimeUnixNano) - Number(b.startTimeUnixNano));
      const root = ordered.find((span) => !span.parentSpanId) ?? ordered[0];
      if (!root) {
        continue;
      }

      const start = ordered.reduce((min, span) => min < Number(span.startTimeUnixNano) ? min : Number(span.startTimeUnixNano), Number(root.startTimeUnixNano));
      const end = ordered.reduce((max, span) => max > Number(span.endTimeUnixNano) ? max : Number(span.endTimeUnixNano), Number(root.endTimeUnixNano));
      const services = [...new Set(ordered.map((span) => span.serviceName))].sort();
      const errors = ordered.filter((span) => Number(span.statusCode ?? 0) >= 2);
      const genAi = summarizeGenAi(ordered);

      summaries.set(traceId, {
        traceId,
        rootSpanId: root.spanId,
        rootName: root.name,
        startTimeUnixNano: String(start),
        endTimeUnixNano: String(end),
        durationNano: Math.max(0, end - start),
        serviceNames: services,
        spanCount: ordered.length,
        errorCount: errors.length,
        genAiSpanCount: genAi.spans.length,
        inputTokens: genAi.inputTokens,
        outputTokens: genAi.outputTokens,
        firstErrorMessage: errors[0]?.statusMessage
      });
    }

    this.summaries = summaries;
  }
}

function trimStart<T>(items: T[], limit: number) {
  if (items.length > limit) {
    items.splice(0, items.length - limit);
  }
}

function removeWhere<T>(items: T[], predicate: (item: T) => boolean) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index]!)) {
      items.splice(index, 1);
    }
  }
}

export function summarizeGenAi(spans: NormalizedSpan[]): GenAiTraceSummary {
  const genAiSpans = spans
    .map((span) => classifyGenAiSpan(span))
    .filter((span) => span.kind !== "unknown");
  const inputTokens = sumDefined(genAiSpans.map((span) => span.inputTokens));
  const outputTokens = sumDefined(genAiSpans.map((span) => span.outputTokens));
  const totalTokens = inputTokens !== undefined || outputTokens !== undefined ? (inputTokens ?? 0) + (outputTokens ?? 0) : undefined;
  const longest = genAiSpans
    .filter((span) => span.durationNano !== undefined)
    .sort((a, b) => (b.durationNano ?? 0) - (a.durationNano ?? 0))[0];

  return {
    spans: genAiSpans,
    timeline: genAiSpans
      .sort((a, b) => Number(a.startTimeUnixNano) - Number(b.startTimeUnixNano))
      .map((span) => ({
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
        kind: span.kind,
        name: span.name,
        label: span.model ?? span.toolName ?? span.name,
        startTimeUnixNano: span.startTimeUnixNano,
        durationNano: span.durationNano ?? 0,
        status: span.error ? "error" : "ok",
        provider: span.provider,
        model: span.model,
        toolName: span.toolName,
        inputTokens: span.inputTokens,
        outputTokens: span.outputTokens
      })),
    rag: {
      retrievalSpanCount: genAiSpans.filter((span) => span.kind === "retrieval").length,
      retrievedDocCount: genAiSpans.reduce((sum, span) => sum + (span.retrievedDocCount ?? 0), 0),
      rerankSpanCount: genAiSpans.filter((span) => span.kind === "rerank").length,
      embeddingSpanCount: genAiSpans.filter((span) => span.kind === "embedding").length
    },
    longestStep: longest ? { spanId: longest.spanId, name: longest.name, durationNano: longest.durationNano ?? 0 } : undefined,
    inputTokens,
    outputTokens,
    totalTokens,
    estimatedCostUsd: estimateCostUsd(genAiSpans),
    toolCallCount: genAiSpans.filter((span) => span.kind === "tool.call" || span.kind === "mcp.tool").length,
    failedToolCallCount: genAiSpans.filter((span) => (span.kind === "tool.call" || span.kind === "mcp.tool") && span.error).length
  };
}

function classifyGenAiSpan(span: NormalizedSpan) {
  const attrs = span.attributes;
  const system = readString(attrs, "gen_ai.system") ?? readString(attrs, "llm.system") ?? readString(attrs, "llm.provider");
  const operation = readString(attrs, "gen_ai.operation.name") ?? readString(attrs, "llm.operation");
  const openInferenceKind = readString(attrs, "openinference.span.kind")?.toLowerCase();
  const name = span.name.toLowerCase();
  let kind = "unknown";

  if (system || operation || openInferenceKind === "llm" || name.includes("chat") || name.includes("completion")) {
    kind = operation?.includes("embedding") ? "embedding" : operation?.includes("completion") ? "llm.completion" : "llm.chat";
  }
  if (openInferenceKind === "embedding" || name.includes("embedding")) {
    kind = "embedding";
  }
  if (openInferenceKind === "reranker" || name.includes("rerank")) {
    kind = "rerank";
  }
  if (openInferenceKind === "retriever" || name.includes("retriev") || name.includes("vector search")) {
    kind = "retrieval";
  }
  if (openInferenceKind === "tool" || name.includes("tool") || readString(attrs, "tool.name")) {
    kind = "tool.call";
  }
  if (readString(attrs, "mcp.tool.name")) {
    kind = "mcp.tool";
  }
  if (name.includes("agent") || openInferenceKind === "agent") {
    kind = name.includes("plan") ? "agent.plan" : "agent.step";
  }

  return {
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    kind,
    name: span.name,
    serviceName: span.serviceName,
    startTimeUnixNano: span.startTimeUnixNano,
    durationNano: span.durationNano,
    error: Number(span.statusCode ?? 0) >= 2,
    provider: readString(attrs, "gen_ai.system") ?? readString(attrs, "llm.provider") ?? readString(attrs, "ai.provider"),
    model: readString(attrs, "gen_ai.request.model") ?? readString(attrs, "llm.model_name") ?? readString(attrs, "gen_ai.response.model") ?? readString(attrs, "model_name"),
    inputTokens: readNumber(attrs, "gen_ai.usage.input_tokens") ?? readNumber(attrs, "llm.token_count.prompt") ?? readNumber(attrs, "llm.usage.prompt_tokens"),
    outputTokens: readNumber(attrs, "gen_ai.usage.output_tokens") ?? readNumber(attrs, "llm.token_count.completion") ?? readNumber(attrs, "llm.usage.completion_tokens"),
    toolName: readString(attrs, "tool.name") ?? readString(attrs, "mcp.tool.name") ?? readString(attrs, "function.name"),
    retrievedDocCount: readNumber(attrs, "retrieval.documents.count") ?? readNumber(attrs, "rag.retrieved_doc_count") ?? readNumber(attrs, "retrieved_document_count"),
    redactedContentKeys: Object.keys(attrs).filter((key) => typeof attrs[key] === "string" && String(attrs[key]).includes("[redacted"))
  };
}

function estimateCostUsd(spans: ReturnType<typeof classifyGenAiSpan>[]): number | undefined {
  let total = 0;
  let found = false;
  for (const span of spans) {
    const model = span.model?.toLowerCase() ?? "";
    const input = span.inputTokens ?? 0;
    const output = span.outputTokens ?? 0;
    const rate = model.includes("gpt-4.1") ? { input: 0.002, output: 0.008 } :
      model.includes("gpt-4o") ? { input: 0.005, output: 0.015 } :
      model.includes("claude") ? { input: 0.003, output: 0.015 } :
      undefined;
    if (!rate || (input === 0 && output === 0)) {
      continue;
    }
    found = true;
    total += (input / 1000) * rate.input + (output / 1000) * rate.output;
  }
  return found ? Number(total.toFixed(6)) : undefined;
}

function readString(attrs: Record<string, unknown>, key: string): string | undefined {
  const value = attrs[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(attrs: Record<string, unknown>, key: string): number | undefined {
  const value = attrs[key];
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function sumDefined(values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  if (present.length === 0) {
    return undefined;
  }
  return present.reduce((sum, value) => sum + value, 0);
}
