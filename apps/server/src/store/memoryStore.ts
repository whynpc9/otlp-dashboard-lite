import { nanoid } from "nanoid";
import type {
  GenAiTraceListQuery,
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
  SpanQuery,
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
  maxMetricAttributeSets?: number;
}

type ConversationTurnDraft = {
  spanId: string;
  role: "system" | "user" | "assistant" | "tool";
  kind: "message" | "tool-call" | "tool-result";
  name?: string | undefined;
  contentPreview: string;
  reasoningPreview?: string | undefined;
};

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
    const metrics = this.filterMetricsByCardinality(batch.metrics);
    this.batches.push(batch.raw);
    this.spans.push(...batch.spans);
    this.logs.push(...batch.logs);
    this.metrics.push(...metrics);

    trimStart(this.batches, this.limits.maxBatches);
    trimStart(this.spans, this.limits.maxSpans);
    trimStart(this.logs, this.limits.maxLogs);
    trimStart(this.metrics, this.limits.maxMetrics ?? 100_000);

    this.rebuildTraceSummaries();

    return {
      accepted: batch.spans.length + batch.logs.length + metrics.length,
      rejected: batch.metrics.length - metrics.length,
      warnings: metrics.length === batch.metrics.length ? [] : [`Dropped ${batch.metrics.length - metrics.length} metric points due to attribute cardinality limits.`]
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
    if (query.fromUnixNano) {
      rows = rows.filter((trace) => trace.endTimeUnixNano >= query.fromUnixNano!);
    }
    if (query.toUnixNano) {
      rows = rows.filter((trace) => trace.startTimeUnixNano <= query.toUnixNano!);
    }
    if (query.q) {
      const q = query.q.toLowerCase();
      rows = rows.filter((trace) => trace.rootName.toLowerCase().includes(q) || trace.traceId.includes(q));
    }

    return rows
      .sort((a, b) => Number(b.startTimeUnixNano) - Number(a.startTimeUnixNano))
      .slice(query.offset ?? 0, (query.offset ?? 0) + query.limit);
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

  listSpans(query: SpanQuery): NormalizedSpan[] {
    let rows = [...this.spans];

    if (query.service) {
      rows = rows.filter((span) => span.serviceName === query.service);
    }
    if (query.traceId) {
      rows = rows.filter((span) => span.traceId === query.traceId);
    }
    if (query.hasError !== undefined) {
      rows = rows.filter((span) => (Number(span.statusCode ?? 0) >= 2) === query.hasError);
    }
    if (query.minDurationMs !== undefined) {
      rows = rows.filter((span) => span.durationNano >= query.minDurationMs! * 1_000_000);
    }
    if (query.fromUnixNano) {
      rows = rows.filter((span) => span.endTimeUnixNano >= query.fromUnixNano!);
    }
    if (query.toUnixNano) {
      rows = rows.filter((span) => span.startTimeUnixNano <= query.toUnixNano!);
    }
    if (query.q) {
      const q = query.q.toLowerCase();
      rows = rows.filter((span) => {
        return (
          span.name.toLowerCase().includes(q) ||
          span.traceId.includes(q) ||
          span.spanId.includes(q) ||
          JSON.stringify(span.attributes).toLowerCase().includes(q)
        );
      });
    }

    return rows
      .sort((a, b) => Number(b.startTimeUnixNano) - Number(a.startTimeUnixNano))
      .slice(query.offset ?? 0, (query.offset ?? 0) + query.limit);
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
    if (query.fromUnixNano) {
      rows = rows.filter((log) => (log.timeUnixNano ?? log.observedTimeUnixNano ?? "0") >= query.fromUnixNano!);
    }
    if (query.toUnixNano) {
      rows = rows.filter((log) => (log.timeUnixNano ?? log.observedTimeUnixNano ?? "0") <= query.toUnixNano!);
    }

    return rows
      .sort((a, b) => Number(b.timeUnixNano ?? b.observedTimeUnixNano ?? 0) - Number(a.timeUnixNano ?? a.observedTimeUnixNano ?? 0))
      .slice(query.offset ?? 0, (query.offset ?? 0) + query.limit);
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
      if (query.fromUnixNano && point.timeUnixNano < query.fromUnixNano) {
        continue;
      }
      if (query.toUnixNano && point.timeUnixNano > query.toUnixNano) {
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
      .slice(query.offset ?? 0, (query.offset ?? 0) + query.limit);
  }

  getMetricSeries(query: MetricSeriesQuery): MetricSeriesPoint[] {
    return this.metrics
      .filter((point) => point.metricName === query.metricName)
      .filter((point) => !query.service || point.serviceName === query.service)
      .filter((point) => !query.meterName || point.meterName === query.meterName)
      .filter((point) => !query.attrs || point.attributesHash === query.attrs)
      .filter((point) => !query.fromUnixNano || point.timeUnixNano >= query.fromUnixNano)
      .filter((point) => !query.toUnixNano || point.timeUnixNano <= query.toUnixNano)
      .sort((a, b) => Number(a.timeUnixNano) - Number(b.timeUnixNano))
      .slice(query.offset ?? 0, (query.offset ?? 0) + query.limit)
      .map((point) => ({
        timeUnixNano: point.timeUnixNano,
        value: point.value,
        count: point.count,
        sum: point.sum,
        min: point.min,
        max: point.max,
        attributes: point.attributes,
        exemplars: point.exemplars,
        distribution: point.distribution
      }));
  }

  listGenAiTraces(query: GenAiTraceListQuery = {}): TraceSummary[] {
    return this.listTraces({
      service: query.service,
      q: query.q,
      fromUnixNano: query.fromUnixNano,
      toUnixNano: query.toUnixNano,
      offset: query.offset,
      limit: query.limit ?? 100
    }).filter((trace) => trace.genAiSpanCount > 0);
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

  private filterMetricsByCardinality(metrics: NormalizedMetricPoint[]) {
    const limit = this.limits.maxMetricAttributeSets ?? 1_000;
    const seen = new Map<string, Set<string>>();
    for (const point of this.metrics) {
      const key = metricCardinalityKey(point);
      const attrs = seen.get(key) ?? new Set<string>();
      attrs.add(point.attributesHash);
      seen.set(key, attrs);
    }

    return metrics.filter((point) => {
      const key = metricCardinalityKey(point);
      const attrs = seen.get(key) ?? new Set<string>();
      if (!attrs.has(point.attributesHash) && attrs.size >= limit) {
        return false;
      }
      attrs.add(point.attributesHash);
      seen.set(key, attrs);
      return true;
    });
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

function metricCardinalityKey(point: NormalizedMetricPoint) {
  return `${point.serviceName}\n${point.meterName}\n${point.metricName}\n${point.metricType}`;
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
    conversation: buildTraceConversation(spans, genAiSpans).slice(0, 80),
    rag: {
      retrievalSpanCount: genAiSpans.filter((span) => span.kind === "retrieval").length,
      retrievedDocCount: genAiSpans.reduce((sum, span) => sum + (span.retrievedDocCount ?? span.retrievedDocuments.length), 0),
      rerankSpanCount: genAiSpans.filter((span) => span.kind === "rerank").length,
      embeddingSpanCount: genAiSpans.filter((span) => span.kind === "embedding").length,
      documents: genAiSpans.flatMap((span) => span.retrievedDocuments.map((document) => ({
        spanId: span.spanId,
        ...document
      }))).slice(0, 20)
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
  const system = readFirstString(attrs, ["gen_ai.system", "gen_ai.provider.name", "llm.system", "llm.provider", "ai.model.provider"]);
  const operation = readFirstString(attrs, ["gen_ai.operation.name", "llm.operation", "ai.operationId", "operation.name"]);
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
    provider: readFirstString(attrs, ["gen_ai.system", "gen_ai.provider.name", "llm.provider", "ai.provider", "ai.model.provider"]),
    model: readFirstString(attrs, ["gen_ai.request.model", "llm.model_name", "gen_ai.response.model", "ai.response.model", "ai.model.id", "model_name"]),
    inputTokens: readNumber(attrs, "gen_ai.usage.input_tokens") ?? readNumber(attrs, "llm.token_count.prompt") ?? readNumber(attrs, "llm.usage.prompt_tokens") ?? readNumber(attrs, "ai.usage.promptTokens"),
    outputTokens: readNumber(attrs, "gen_ai.usage.output_tokens") ?? readNumber(attrs, "llm.token_count.completion") ?? readNumber(attrs, "llm.usage.completion_tokens") ?? readNumber(attrs, "ai.usage.completionTokens"),
    toolName: readString(attrs, "tool.name") ?? readString(attrs, "mcp.tool.name") ?? readString(attrs, "function.name") ?? readString(attrs, "ai.toolCall.name"),
    retrievedDocCount: readNumber(attrs, "retrieval.documents.count") ?? readNumber(attrs, "rag.retrieved_doc_count") ?? readNumber(attrs, "retrieved_document_count"),
    retrievedDocuments: extractRagDocuments(attrs),
    conversationTurns: extractConversationTurns(span),
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

function extractRagDocuments(attrs: Record<string, unknown>) {
  const direct = attrs["retrieval.documents"] ?? attrs["openinference.retrieval.documents"] ?? attrs["rag.documents"];
  if (Array.isArray(direct)) {
    return direct.map((item) => normalizeRagDocument(item)).filter((item) => item.contentPreview || item.title || item.id);
  }

  const grouped = new Map<string, Record<string, unknown>>();
  for (const [key, value] of Object.entries(attrs)) {
    const match = key.match(/(?:retrieval|rag)\.documents?\.(\d+)\.(.+)/i);
    if (!match) {
      continue;
    }
    const index = match[1]!;
    const field = match[2]!;
    const document = grouped.get(index) ?? {};
    document[field] = value;
    grouped.set(index, document);
  }
  return [...grouped.keys()]
    .sort((a, b) => Number(a) - Number(b))
    .map((key) => normalizeRagDocument(grouped.get(key)))
    .filter((item) => item.contentPreview || item.title || item.id);
}

function normalizeRagDocument(value: unknown) {
  const record = isRecord(value) ? value : {};
  const content = readString(record, "content") ?? readString(record, "document.content") ?? readString(record, "text") ?? (typeof value === "string" ? value : undefined);
  return {
    id: readString(record, "id") ?? readString(record, "document.id"),
    title: readString(record, "title") ?? readString(record, "document.title"),
    score: readNumber(record, "score") ?? readNumber(record, "document.score"),
    contentPreview: content ? truncate(content, 220) : undefined
  };
}

function readToolNameFromAttrs(attrs: Record<string, unknown>): string | undefined {
  return readString(attrs, "tool.name")
    ?? readString(attrs, "mcp.tool.name")
    ?? readString(attrs, "function.name")
    ?? readString(attrs, "gen_ai.tool.name")
    ?? readString(attrs, "ai.toolCall.name");
}

function readAssistantReasoning(attrs: Record<string, unknown>): string | undefined {
  return readFirstString(attrs, [
    "gen_ai.response.reasoning_content",
    "gen_ai.response.reasoning",
    "gen_ai.assistant.reasoning",
    "gen_ai.assistant.reasoning_content",
    "gen_ai.reasoning_content",
    "gen_ai.reasoning",
    "llm.reasoning",
    "llm.reasoning_content",
    "output.reasoning",
    "openinference.output.reasoning"
  ]);
}

function turnFingerprint(turn: ConversationTurnDraft): string {
  return `${turn.role}|${turn.kind}|${turn.name ?? ""}|${turn.contentPreview}|${turn.reasoningPreview ?? ""}`;
}

function addTurnDeduped(
  seen: Set<string>,
  turns: ConversationTurnDraft[],
  span: NormalizedSpan,
  role: "system" | "user" | "assistant" | "tool",
  kind: "message" | "tool-call" | "tool-result",
  value?: string,
  name?: string,
  reasoning?: string | undefined
) {
  const draft: ConversationTurnDraft = {
    spanId: span.spanId,
    role,
    kind,
    name,
    contentPreview: typeof value === "string" && value.length > 0 ? truncate(value, 2000) : ""
  };
  if (typeof reasoning === "string" && reasoning.length > 0) {
    draft.reasoningPreview = truncate(reasoning, 4000);
  }
  if (!draft.contentPreview && !draft.reasoningPreview) {
    return;
  }
  const fingerprint = turnFingerprint(draft);
  if (seen.has(fingerprint)) {
    return;
  }
  seen.add(fingerprint);
  turns.push(draft);
}

function findAgentStepSpanId(span: NormalizedSpan, spanById: Map<string, NormalizedSpan>): string | undefined {
  let current: NormalizedSpan | undefined = span;
  while (current) {
    if (current.name.startsWith("agent.step.")) {
      return current.spanId;
    }
    current = current.parentSpanId ? spanById.get(current.parentSpanId) : undefined;
  }
  return undefined;
}

function extractInferenceSpanTurns(span: NormalizedSpan): ConversationTurnDraft[] {
  const attrs = span.attributes;
  const turns: ConversationTurnDraft[] = [];
  const toolName = readToolNameFromAttrs(attrs);

  addTurnsFromMessagesArray(turns, span, attrs["ai.prompt.messages"], toolName, "user");
  addTurn(
    turns,
    span,
    "assistant",
    "message",
    readFirstString(attrs, ["ai.response.text", "gen_ai.completion", "gen_ai.output"]),
    undefined,
    readAssistantReasoning(attrs)
  );
  addTurnsFromToolCalls(turns, span, attrs["ai.response.toolCalls"], toolName);
  addTurn(turns, span, "tool", "tool-call", readFirstString(attrs, [
    "ai.toolCall.args",
    "tool.input",
    "tool.args",
    "tool.arguments"
  ]), toolName);
  addTurn(turns, span, "tool", "tool-result", readFirstString(attrs, [
    "ai.toolCall.result",
    "tool.output",
    "tool.result"
  ]), toolName);
  addTurnsFromMessagesArray(turns, span, attrs["gen_ai.input.messages"], toolName, "user");
  addTurnsFromMessagesArray(turns, span, attrs["gen_ai.output.messages"], toolName, "assistant");

  for (const event of span.events) {
    const eventRecord = isRecord(event) ? event : {};
    const eventAttrs = isRecord(eventRecord.attributes) ? eventRecord.attributes as Record<string, unknown> : eventRecord;
    addTurnsFromMessagesArray(turns, span, eventAttrs["gen_ai.input.messages"], toolName, "user");
    addTurnsFromMessagesArray(turns, span, eventAttrs["gen_ai.output.messages"], toolName, "assistant");
  }

  return turns;
}

function extractGenerateTextWrapperTurns(span: NormalizedSpan): ConversationTurnDraft[] {
  const attrs = span.attributes;
  const turns: ConversationTurnDraft[] = [];
  if (parseMaybeJsonArray(attrs["ai.prompt.messages"])) {
    return turns;
  }
  const prompt = readFirstString(attrs, ["ai.prompt"]);
  if (prompt) {
    const parsed = parseMaybeJsonObject(prompt);
    if (parsed) {
      addTurn(turns, span, "system", "message", readString(parsed, "system"));
      addTurn(turns, span, "user", "message", readString(parsed, "prompt") ?? readString(parsed, "messages"));
    } else {
      addTurn(turns, span, "user", "message", prompt);
    }
  }
  addTurn(
    turns,
    span,
    "assistant",
    "message",
    readFirstString(attrs, ["ai.response.text", "gen_ai.completion", "gen_ai.output"]),
    undefined,
    readAssistantReasoning(attrs)
  );
  return turns;
}

function buildTraceConversation(
  spans: NormalizedSpan[],
  genAiSpans: ReturnType<typeof classifyGenAiSpan>[]
): ConversationTurnDraft[] {
  const spanById = new Map(spans.map((span) => [span.spanId, span]));
  const inferenceSpans = spans
    .filter((span) => span.name === "ai.generateText.doGenerate")
    .sort((a, b) => Number(a.startTimeUnixNano) - Number(b.startTimeUnixNano));

  if (inferenceSpans.length === 0) {
    return genAiSpans
      .sort((a, b) => Number(a.startTimeUnixNano) - Number(b.startTimeUnixNano))
      .flatMap((span) => span.conversationTurns);
  }

  const turns: ConversationTurnDraft[] = [];
  const seen = new Set<string>();
  let previousPromptLength = 0;
  let currentStepId: string | undefined;

  for (const span of inferenceSpans) {
    const stepId = findAgentStepSpanId(span, spanById);
    if (stepId !== currentStepId) {
      currentStepId = stepId;
      previousPromptLength = 0;
    }

    const attrs = span.attributes;
    const toolName = readToolNameFromAttrs(attrs);
    const promptMessages = parseMaybeJsonArray(attrs["ai.prompt.messages"]) ?? [];

    for (let index = previousPromptLength; index < promptMessages.length; index += 1) {
      const entry = promptMessages[index];
      if (!isRecord(entry)) {
        continue;
      }
      addTurnsFromMessageEntry(turns, span, entry, toolName, seen);
    }
    previousPromptLength = promptMessages.length;

    addTurnDeduped(
      seen,
      turns,
      span,
      "assistant",
      "message",
      readFirstString(attrs, ["ai.response.text", "gen_ai.completion", "gen_ai.output"]),
      undefined,
      readAssistantReasoning(attrs)
    );
    addTurnsFromToolCallsDeduped(turns, span, attrs["ai.response.toolCalls"], toolName, seen);
    addTurnDeduped(
      seen,
      turns,
      span,
      "tool",
      "tool-call",
      readFirstString(attrs, ["ai.toolCall.args", "tool.input", "tool.args", "tool.arguments"]),
      toolName
    );
    addTurnDeduped(
      seen,
      turns,
      span,
      "tool",
      "tool-result",
      readFirstString(attrs, ["ai.toolCall.result", "tool.output", "tool.result"]),
      toolName
    );
  }

  return turns;
}

function extractConversationTurns(span: NormalizedSpan) {
  if (span.name === "ai.generateText.doGenerate") {
    return extractInferenceSpanTurns(span);
  }
  if (span.name === "ai.generateText") {
    return extractGenerateTextWrapperTurns(span);
  }

  const attrs = span.attributes;
  const turns: ConversationTurnDraft[] = [];
  const toolName = readToolNameFromAttrs(attrs);

  addTurn(turns, span, "system", "message", readFirstString(attrs, ["gen_ai.system.message", "llm.system", "system"]));
  addTurn(turns, span, "user", "message", readFirstString(attrs, [
    "gen_ai.prompt",
    "gen_ai.input",
    "ai.prompt",
    "llm.prompt",
    "input.value",
    "input",
    "openinference.input.value"
  ]));
  addTurnsFromIndexedMessages(turns, span, attrs, "gen_ai.prompt", toolName, "user");
  addTurnsFromMessagesArray(turns, span, attrs["ai.prompt.messages"], toolName, "user");
  const assistantReasoning = readFirstString(attrs, [
    "gen_ai.response.reasoning_content",
    "gen_ai.response.reasoning",
    "gen_ai.assistant.reasoning",
    "gen_ai.assistant.reasoning_content",
    "gen_ai.reasoning_content",
    "gen_ai.reasoning",
    "llm.reasoning",
    "llm.reasoning_content",
    "output.reasoning",
    "openinference.output.reasoning"
  ]);
  addTurn(
    turns,
    span,
    "assistant",
    "message",
    readFirstString(attrs, [
      "gen_ai.completion",
      "gen_ai.output",
      "ai.response.text",
      "llm.completion",
      "output.value",
      "output",
      "openinference.output.value"
    ]),
    undefined,
    assistantReasoning
  );
  addTurnsFromIndexedMessages(turns, span, attrs, "gen_ai.completion", toolName, "assistant");
  addTurnsFromMessagesArray(turns, span, attrs["ai.response.messages"], toolName, "assistant");
  addTurn(turns, span, "tool", "tool-call", readFirstString(attrs, [
    "tool.input",
    "tool.args",
    "tool.arguments",
    "tool.parameters",
    "mcp.tool.arguments",
    "function.arguments",
    "gen_ai.tool.arguments",
    "ai.toolCall.args"
  ]), toolName);
  addTurn(turns, span, "tool", "tool-result", readFirstString(attrs, [
    "tool.output",
    "tool.result",
    "mcp.tool.result",
    "function.result",
    "gen_ai.tool.result",
    "ai.toolCall.result"
  ]), toolName);

  // Newer OTel GenAI semconv (≈2.x experimental): single structured array attributes that hold
  // every input/output message with role + typed parts.
  addTurnsFromMessagesArray(turns, span, attrs["gen_ai.input.messages"], toolName, "user");
  addTurnsFromMessagesArray(turns, span, attrs["gen_ai.output.messages"], toolName, "assistant");
  addTurnsFromToolCalls(turns, span, attrs["ai.response.toolCalls"], toolName);

  for (const event of span.events) {
    const eventRecord = isRecord(event) ? event : {};
    const eventAttrs = isRecord(eventRecord.attributes) ? eventRecord.attributes as Record<string, unknown> : eventRecord;
    const eventName = readString(eventRecord, "name");

    // Newer semconv `gen_ai.client.inference.operation.details` event mirrors the input/output arrays.
    addTurnsFromMessagesArray(turns, span, eventAttrs["gen_ai.input.messages"], toolName, "user");
    addTurnsFromMessagesArray(turns, span, eventAttrs["gen_ai.output.messages"], toolName, "assistant");

    // OTel GenAI `gen_ai.choice` event holds a nested `message: { role, content, tool_calls }`.
    const choiceMessage = parseMaybeJsonObject(eventAttrs["message"]);
    if (choiceMessage) {
      const choiceRole = conversationRole(readString(choiceMessage, "role"))
        ?? roleFromEventName(eventName)
        ?? "assistant";
      const choiceContent = extractMessageContent(choiceMessage);
      const choiceReasoning = extractReasoningContent(choiceMessage);
      if (choiceContent) {
        addTurn(turns, span, choiceRole, "message", choiceContent, undefined, choiceReasoning);
      }
      addTurnsFromToolCalls(turns, span, choiceMessage["tool_calls"], toolName);
    }

    // Standard OTel GenAI message events: `gen_ai.{system|user|assistant|tool}.message`.
    const role = conversationRole(readString(eventAttrs, "role") ?? readString(eventAttrs, "message.role"))
      ?? roleFromEventName(eventName);
    const content = extractMessageContent(eventAttrs);
    const reasoning = extractReasoningContent(eventAttrs);
    if (role && content) {
      const kind = role === "tool"
        ? (eventName?.toLowerCase().includes("result") || eventName?.toLowerCase().includes("output") ? "tool-result" : "tool-call")
        : "message";
      addTurn(turns, span, role, kind, content, eventName, reasoning);
    }

    // Assistant message events can carry `tool_calls` as a structured array.
    addTurnsFromToolCalls(turns, span, eventAttrs["tool_calls"], toolName);
  }

  return turns;
}

function addTurnsFromIndexedMessages(
  turns: ConversationTurnDraft[],
  span: NormalizedSpan,
  attrs: Record<string, unknown>,
  prefix: string,
  fallbackToolName: string | undefined,
  defaultRole: "user" | "assistant"
) {
  const grouped = new Map<string, Record<string, unknown>>();
  const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.(\\d+)\\.(.+)$`);
  for (const [key, value] of Object.entries(attrs)) {
    const match = key.match(pattern);
    if (!match) {
      continue;
    }
    const index = match[1]!;
    const field = match[2]!;
    const message = grouped.get(index) ?? {};
    message[field] = value;
    grouped.set(index, message);
  }

  for (const index of [...grouped.keys()].sort((a, b) => Number(a) - Number(b))) {
    const message = grouped.get(index)!;
    const role = conversationRole(readString(message, "role")) ?? defaultRole;
    const content = extractMessageContent(message);
    const reasoning = extractReasoningContent(message);
    if (content || reasoning) {
      addTurn(turns, span, role, role === "tool" ? "tool-result" : "message", content ?? "", fallbackToolName, reasoning);
    }
    addTurnsFromToolCalls(turns, span, message.tool_calls, fallbackToolName);
  }
}

// Handles the newer OTel GenAI structured `messages` array, where each entry has
// `{ role, parts: [{ type: "text" | "tool_call" | "tool_call_response" | "reasoning" | "thinking", ... }] }`.
function addTurnsFromMessagesArray(
  turns: ConversationTurnDraft[],
  span: NormalizedSpan,
  value: unknown,
  fallbackToolName: string | undefined,
  defaultRole: "user" | "assistant"
) {
  const list = parseMaybeJsonArray(value);
  if (!list) return;
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    addTurnsFromMessageEntry(turns, span, entry, fallbackToolName, undefined, defaultRole);
  }
}

function addTurnsFromMessageEntry(
  turns: ConversationTurnDraft[],
  span: NormalizedSpan,
  entry: Record<string, unknown>,
  fallbackToolName: string | undefined,
  seen: Set<string> | undefined,
  defaultRole: "user" | "assistant" = "user"
) {
  const role = conversationRole(readString(entry, "role")) ?? defaultRole;
  const parts = parseMaybeJsonArray(entry.parts) ?? parseMaybeJsonArray(entry.content);
  if (parts && parts.length > 0) {
    const textChunks: string[] = [];
    const reasoningChunks: string[] = [];
    const toolCalls: Array<{ name: string | undefined; content: string }> = [];
    const toolResults: Array<{ name: string | undefined; content: string }> = [];
    for (const part of parts) {
      if (typeof part === "string") {
        textChunks.push(part);
        continue;
      }
      if (!isRecord(part)) continue;
      const type = (readString(part, "type") ?? "text").toLowerCase();
      if (type === "tool_call" || type === "tool-call" || type === "tool_use") {
        const name = readString(part, "name")
          ?? readString(part, "tool_name")
          ?? readString(part, "toolName")
          ?? fallbackToolName;
        const args = flattenContentValue(part.arguments ?? part.input ?? part.parameters);
        if (args) {
          toolCalls.push({ name, content: args });
        }
      } else if (type === "tool_call_response" || type === "tool_result" || type === "tool-result") {
        const name = readString(part, "name")
          ?? readString(part, "tool_name")
          ?? readString(part, "toolName")
          ?? fallbackToolName;
        const result = flattenContentValue(part.response ?? part.result ?? part.output ?? part.content);
        if (result) {
          toolResults.push({ name, content: result });
        }
      } else if (type === "reasoning" || type === "reasoning_content" || type === "thinking" || type === "text") {
        const text = flattenContentValue(part.content ?? part.text ?? part.thinking ?? part.reasoning ?? part.value ?? part);
        if (!text) {
          continue;
        }
        if (type === "reasoning" || type === "reasoning_content" || type === "thinking") {
          reasoningChunks.push(text);
        } else {
          textChunks.push(text);
        }
      } else {
        const text = flattenContentValue(part.content ?? part.text ?? part.value ?? part);
        if (text) {
          textChunks.push(text);
        }
      }
    }
    const reasoning = reasoningChunks.length > 0 ? reasoningChunks.join("\n\n") : undefined;
    if (textChunks.length > 0) {
      pushTurn(turns, span, role, "message", textChunks.join("\n\n"), undefined, reasoning, seen);
    } else if (reasoning) {
      pushTurn(turns, span, role, "message", "", undefined, reasoning, seen);
    }
    for (const call of toolCalls) {
      pushTurn(turns, span, "tool", "tool-call", call.content, call.name, undefined, seen);
    }
    for (const result of toolResults) {
      pushTurn(turns, span, "tool", "tool-result", result.content, result.name, undefined, seen);
    }
    return;
  }

  const content = extractMessageContent(entry);
  const reasoning = extractReasoningContent(entry);
  if (content) {
    pushTurn(turns, span, role, "message", content, undefined, reasoning, seen);
  } else if (reasoning) {
    pushTurn(turns, span, role, "message", "", undefined, reasoning, seen);
  }
  addTurnsFromToolCalls(turns, span, entry.tool_calls, fallbackToolName, seen);
}

function pushTurn(
  turns: ConversationTurnDraft[],
  span: NormalizedSpan,
  role: "system" | "user" | "assistant" | "tool",
  kind: "message" | "tool-call" | "tool-result",
  value?: string,
  name?: string,
  reasoning?: string | undefined,
  seen?: Set<string>
) {
  if (seen) {
    addTurnDeduped(seen, turns, span, role, kind, value, name, reasoning);
    return;
  }
  addTurn(turns, span, role, kind, value, name, reasoning);
}

function addTurnsFromToolCallsDeduped(
  turns: ConversationTurnDraft[],
  span: NormalizedSpan,
  value: unknown,
  fallbackName: string | undefined,
  seen: Set<string>
) {
  addTurnsFromToolCalls(turns, span, value, fallbackName, seen);
}

function extractMessageContent(record: Record<string, unknown>): string | undefined {
  for (const key of ["content", "message.content", "body", "text", "value"]) {
    const value = record[key];
    const flat = flattenContentValue(value);
    if (flat) {
      return flat;
    }
  }
  return undefined;
}

function extractReasoningContent(record: Record<string, unknown>): string | undefined {
  for (const key of [
    "reasoning_content",
    "reasoning",
    "thinking",
    "message.reasoning_content",
    "message.reasoning",
    "message.thinking",
    "gen_ai.assistant.reasoning",
    "gen_ai.assistant.reasoning_content",
    "gen_ai.response.reasoning_content",
    "gen_ai.response.reasoning"
  ]) {
    const value = record[key];
    const flat = flattenContentValue(value);
    if (flat) {
      return flat;
    }
  }
  return undefined;
}

function flattenContentValue(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    const parsed = parseMaybeJson(value);
    if (parsed !== undefined && parsed !== value) {
      const nested = flattenContentValue(parsed);
      if (nested) return nested;
    }
    return value;
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => {
        if (typeof item === "string") return item;
        if (isRecord(item)) {
          const text = readString(item, "text") ?? readString(item, "content") ?? readString(item, "value");
          if (text) return text;
          return safeStringify(item);
        }
        return undefined;
      })
      .filter((part): part is string => Boolean(part));
    if (parts.length === 0) return undefined;
    return parts.join("\n\n");
  }
  if (isRecord(value)) {
    if (value.redacted === true) {
      const bytes = typeof value.bytes === "number" ? `${value.bytes} bytes` : "content";
      const hash = typeof value.sha256 === "string" ? `, hash ${value.sha256}` : "";
      return `[redacted ${bytes}${hash}]`;
    }
    if (value.type === "json" && "value" in value) {
      const nested = flattenContentValue(value.value);
      if (nested) {
        return nested;
      }
    }
    const text = readString(value, "text") ?? readString(value, "content") ?? readString(value, "value");
    if (text) return text;
    return safeStringify(value);
  }
  return undefined;
}

function parseMaybeJson(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function parseMaybeJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value;
  if (typeof value === "string") {
    const parsed = parseMaybeJson(value);
    if (isRecord(parsed)) return parsed;
  }
  return undefined;
}

function addTurnsFromToolCalls(
  turns: ConversationTurnDraft[],
  span: NormalizedSpan,
  value: unknown,
  fallbackName: string | undefined,
  seen?: Set<string>
) {
  const list = parseMaybeJsonArray(value);
  if (!list) return;
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const fn = isRecord(entry.function) ? entry.function : entry;
    const callName = readString(fn, "name")
      ?? readString(entry, "name")
      ?? readString(entry, "toolName")
      ?? fallbackName;
    const argsValue = fn.arguments ?? entry.arguments ?? entry.input ?? entry.parameters;
    const args = flattenContentValue(argsValue);
    if (args) {
      pushTurn(turns, span, "tool", "tool-call", args, callName, undefined, seen);
    }
  }
}

function parseMaybeJsonArray(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    const parsed = parseMaybeJson(value);
    if (Array.isArray(parsed)) return parsed;
  }
  return undefined;
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function addTurn(
  turns: ConversationTurnDraft[],
  span: NormalizedSpan,
  role: "system" | "user" | "assistant" | "tool",
  kind: "message" | "tool-call" | "tool-result",
  value?: string,
  name?: string,
  reasoning?: string | undefined
) {
  const hasContent = typeof value === "string" && value.length > 0;
  const hasReasoning = typeof reasoning === "string" && reasoning.length > 0;
  if (!hasContent && !hasReasoning) {
    return;
  }
  const turn: ConversationTurnDraft = {
    spanId: span.spanId,
    role,
    kind,
    name,
    contentPreview: hasContent ? truncate(value!, 2000) : ""
  };
  if (hasReasoning) {
    turn.reasoningPreview = truncate(reasoning!, 4000);
  }
  turns.push(turn);
}

function readFirstString(attrs: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = readContentString(attrs, key);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function readContentString(attrs: Record<string, unknown>, key: string): string | undefined {
  const value = attrs[key];
  if (typeof value === "string") {
    return value;
  }
  if (isRecord(value) && value.redacted === true) {
    const bytes = typeof value.bytes === "number" ? `${value.bytes} bytes` : "content";
    const hash = typeof value.sha256 === "string" ? `, hash ${value.sha256}` : "";
    return `[redacted ${bytes}${hash}]`;
  }
  return undefined;
}

function conversationRole(value: string | undefined): "system" | "user" | "assistant" | "tool" | undefined {
  if (value === "system" || value === "user" || value === "assistant" || value === "tool") {
    return value;
  }
  return undefined;
}

function roleFromEventName(name: string | undefined): "system" | "user" | "assistant" | "tool" | undefined {
  const lower = name?.toLowerCase() ?? "";
  if (lower.includes("system")) return "system";
  if (lower.includes("user") || lower.includes("prompt")) return "user";
  if (lower.includes("assistant") || lower.includes("completion") || lower.includes("response") || lower.includes("choice")) return "assistant";
  if (lower.includes("tool")) return "tool";
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function truncate(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}
