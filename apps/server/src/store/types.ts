export type TelemetrySignal = "traces" | "logs" | "metrics";
export type OtlpProtocol = "http/json" | "http/protobuf";

export interface AttributeMap {
  [key: string]: unknown;
}

export interface RawOtlpBatch {
  id: string;
  signal: TelemetrySignal;
  protocol: OtlpProtocol;
  receivedAt: number;
  contentType: string;
  contentEncoding?: string | undefined;
  bodySize: number;
  bodyBase64?: string | undefined;
  resourceServiceNames: string[];
  rawJson?: unknown | undefined;
}

export interface NormalizedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string | undefined;
  serviceName: string;
  name: string;
  kind?: number | undefined;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  durationNano: number;
  statusCode?: number | undefined;
  statusMessage?: string | undefined;
  resource: AttributeMap;
  scope: AttributeMap;
  attributes: AttributeMap;
  events: Array<Record<string, unknown>>;
  links: Array<Record<string, unknown>>;
  batchId: string;
}

export interface NormalizedLogRecord {
  id: string;
  traceId?: string | undefined;
  spanId?: string | undefined;
  serviceName: string;
  severityNumber?: number | undefined;
  severityText?: string | undefined;
  timeUnixNano?: string | undefined;
  observedTimeUnixNano?: string | undefined;
  bodyText?: string | undefined;
  bodyJson?: unknown | undefined;
  resource: AttributeMap;
  scope: AttributeMap;
  attributes: AttributeMap;
  batchId: string;
}

export interface NormalizedMetricPoint {
  id: string;
  serviceName: string;
  meterName: string;
  metricName: string;
  metricType: string;
  description?: string | undefined;
  unit?: string | undefined;
  temporality?: number | undefined;
  isMonotonic?: boolean | undefined;
  startTimeUnixNano?: string | undefined;
  timeUnixNano: string;
  value?: number | undefined;
  count?: number | undefined;
  sum?: number | undefined;
  min?: number | undefined;
  max?: number | undefined;
  attributesHash: string;
  attributes: AttributeMap;
  exemplars: Array<Record<string, unknown>>;
  distribution?: Record<string, unknown> | undefined;
  batchId: string;
}

export interface MetricDescriptor {
  serviceName: string;
  meterName: string;
  metricName: string;
  metricType: string;
  description?: string | undefined;
  unit?: string | undefined;
  pointCount: number;
  lastSeen: number;
  attributeSets: number;
}

export interface MetricSeriesPoint {
  timeUnixNano: string;
  value?: number | undefined;
  count?: number | undefined;
  sum?: number | undefined;
  min?: number | undefined;
  max?: number | undefined;
  attributes: AttributeMap;
  exemplars: Array<Record<string, unknown>>;
  distribution?: Record<string, unknown> | undefined;
}

export interface TraceSummary {
  traceId: string;
  rootSpanId?: string | undefined;
  rootName: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  durationNano: number;
  serviceNames: string[];
  spanCount: number;
  errorCount: number;
  genAiSpanCount: number;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  firstErrorMessage?: string | undefined;
}

export interface TraceDetail extends TraceSummary {
  spans: NormalizedSpan[];
  logs: NormalizedLogRecord[];
  genAi: GenAiTraceSummary;
}

export interface GenAiTraceSummary {
  spans: Array<{
    spanId: string;
    parentSpanId?: string | undefined;
    kind: string;
    name: string;
    serviceName?: string | undefined;
    provider?: string | undefined;
    model?: string | undefined;
    inputTokens?: number | undefined;
    outputTokens?: number | undefined;
    toolName?: string | undefined;
    durationNano?: number | undefined;
    error?: boolean | undefined;
    redactedContentKeys?: string[] | undefined;
  }>;
  timeline: Array<{
    spanId: string;
    parentSpanId?: string | undefined;
    kind: string;
    name: string;
    label: string;
    startTimeUnixNano: string;
    durationNano: number;
    status: "ok" | "error";
    provider?: string | undefined;
    model?: string | undefined;
    toolName?: string | undefined;
    inputTokens?: number | undefined;
    outputTokens?: number | undefined;
  }>;
  conversation: Array<{
    spanId: string;
    role: "system" | "user" | "assistant" | "tool";
    kind: "message" | "tool-call" | "tool-result";
    name?: string | undefined;
    contentPreview: string;
    reasoningPreview?: string | undefined;
  }>;
  rag: {
    retrievalSpanCount: number;
    retrievedDocCount: number;
    rerankSpanCount: number;
    embeddingSpanCount: number;
    documents: Array<{
      spanId: string;
      id?: string | undefined;
      title?: string | undefined;
      score?: number | undefined;
      contentPreview?: string | undefined;
    }>;
  };
  longestStep?: {
    spanId: string;
    name: string;
    durationNano: number;
  } | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
  estimatedCostUsd?: number | undefined;
  toolCallCount: number;
  failedToolCallCount: number;
}

export interface IngestBatch {
  raw: RawOtlpBatch;
  spans: NormalizedSpan[];
  logs: NormalizedLogRecord[];
  metrics: NormalizedMetricPoint[];
}

export interface IngestResult {
  accepted: number;
  rejected: number;
  warnings: string[];
}

export interface TelemetryStore {
  ingest(batch: IngestBatch): IngestResult;
  listResources(): Array<{ serviceName: string; spanCount: number; logCount: number; lastSeen: number }>;
  listTraces(query: TraceListQuery): TraceSummary[];
  getTrace(traceId: string): TraceDetail | undefined;
  listLogs(query: LogQuery): NormalizedLogRecord[];
  listMetrics(query: MetricQuery): MetricDescriptor[];
  getMetricSeries(query: MetricSeriesQuery): MetricSeriesPoint[];
  listGenAiTraces(query?: GenAiTraceListQuery): TraceSummary[];
  exportData(): unknown;
  importData(data: unknown): { imported: number };
  enforceRetention(policy: RetentionPolicy): { deleted: number };
  clear(): void;
  stats(): {
    batches: number;
    spans: number;
	    logs: number;
	    traces: number;
    metrics: number;
    storage: string;
    dbPath?: string;
    dbSizeBytes?: number;
  };
  close?(): void;
}

export interface RetentionPolicy {
  maxAgeMs?: number | undefined;
  maxTraces?: number | undefined;
  maxLogs?: number | undefined;
  maxMetrics?: number | undefined;
  maxDbSizeBytes?: number | undefined;
}

export interface TraceListQuery {
  service?: string | undefined;
  q?: string | undefined;
  hasError?: boolean | undefined;
  minDurationMs?: number | undefined;
  fromUnixNano?: string | undefined;
  toUnixNano?: string | undefined;
  offset?: number | undefined;
  limit: number;
}

export interface LogQuery {
  service?: string | undefined;
  severity?: string | undefined;
  traceId?: string | undefined;
  spanId?: string | undefined;
  q?: string | undefined;
  fromUnixNano?: string | undefined;
  toUnixNano?: string | undefined;
  offset?: number | undefined;
  limit: number;
}

export interface MetricQuery {
  service?: string | undefined;
  q?: string | undefined;
  fromUnixNano?: string | undefined;
  toUnixNano?: string | undefined;
  offset?: number | undefined;
  limit: number;
}

export interface GenAiTraceListQuery {
  service?: string | undefined;
  q?: string | undefined;
  fromUnixNano?: string | undefined;
  toUnixNano?: string | undefined;
  offset?: number | undefined;
  limit?: number | undefined;
}

export interface MetricSeriesQuery {
  metricName: string;
  service?: string | undefined;
  meterName?: string | undefined;
  attrs?: string | undefined;
  fromUnixNano?: string | undefined;
  toUnixNano?: string | undefined;
  offset?: number | undefined;
  limit: number;
}
