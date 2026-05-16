export interface Health {
  ok: boolean;
  spans: number;
  logs: number;
  metrics: number;
  traces: number;
  batches: number;
  storage: string;
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

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string | undefined;
  serviceName: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  durationNano: number;
  statusCode?: number | undefined;
  attributes: Record<string, unknown>;
  events: Array<Record<string, unknown>>;
}

export interface LogRecord {
  id: string;
  traceId?: string | undefined;
  spanId?: string | undefined;
  serviceName: string;
  severityText?: string | undefined;
  severityNumber?: number | undefined;
  timeUnixNano?: string | undefined;
  observedTimeUnixNano?: string | undefined;
  bodyText?: string | undefined;
  bodyJson?: unknown | undefined;
  attributes: Record<string, unknown>;
}

export interface TraceDetail extends TraceSummary {
  spans: Span[];
  logs: LogRecord[];
  genAi: {
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
  };
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
  attributes: Record<string, unknown>;
}

export async function getHealth(): Promise<Health> {
  return getJson("/api/health");
}

export async function listTraces(filters: { service?: string | undefined; q?: string | undefined; hasError?: boolean | undefined }): Promise<TraceSummary[]> {
  const params = new URLSearchParams();
  if (filters.service) params.set("service", filters.service);
  if (filters.q) params.set("q", filters.q);
  if (filters.hasError !== undefined) params.set("hasError", String(filters.hasError));
  params.set("limit", "100");
  const response = await getJson<{ traces: TraceSummary[] }>(`/api/traces?${params.toString()}`);
  return response.traces;
}

export async function getTrace(traceId: string): Promise<TraceDetail | undefined> {
  if (!traceId) return undefined;
  const response = await getJson<{ trace: TraceDetail }>(`/api/traces/${traceId}`);
  return response.trace;
}

export async function listLogs(filters: { service?: string | undefined; traceId?: string | undefined; q?: string | undefined }): Promise<LogRecord[]> {
  const params = new URLSearchParams();
  if (filters.service) params.set("service", filters.service);
  if (filters.traceId) params.set("traceId", filters.traceId);
  if (filters.q) params.set("q", filters.q);
  params.set("limit", "200");
  const response = await getJson<{ logs: LogRecord[] }>(`/api/logs?${params.toString()}`);
  return response.logs;
}

export async function listResources(): Promise<Array<{ serviceName: string; spanCount: number; logCount: number; lastSeen: number }>> {
  const response = await getJson<{ resources: Array<{ serviceName: string; spanCount: number; logCount: number; lastSeen: number }> }>("/api/resources");
  return response.resources;
}

export async function listMetrics(filters: { service?: string | undefined; q?: string | undefined }): Promise<MetricDescriptor[]> {
  const params = new URLSearchParams();
  if (filters.service) params.set("service", filters.service);
  if (filters.q) params.set("q", filters.q);
  params.set("limit", "100");
  const response = await getJson<{ metrics: MetricDescriptor[] }>(`/api/metrics?${params.toString()}`);
  return response.metrics;
}

export async function getMetricSeries(metricName: string, service?: string): Promise<MetricSeriesPoint[]> {
  if (!metricName) return [];
  const params = new URLSearchParams();
  if (service) params.set("service", service);
  params.set("limit", "120");
  const response = await getJson<{ series: MetricSeriesPoint[] }>(`/api/metrics/${encodeURIComponent(metricName)}/series?${params.toString()}`);
  return response.series;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}
