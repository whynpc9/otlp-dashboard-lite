import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertCircle,
  Braces,
  Clock3,
  Database,
  FileText,
  Gauge,
  GitBranch,
  ListFilter,
  MessageSquareCode,
  Radio,
  RotateCw,
  Search,
  Server,
  Settings,
  Sparkles
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { getHealth, getMetricSeries, getTrace, listLogs, listMetrics, listResources, listTraces, type LogRecord, type MetricDescriptor, type MetricSeriesPoint, type Span, type TraceSummary } from "./api.js";

const nav = [
  { label: "Traces", icon: GitBranch },
  { label: "Logs", icon: FileText },
  { label: "Metrics", icon: Gauge },
  { label: "GenAI", icon: Sparkles },
  { label: "Resources", icon: Server },
  { label: "Settings", icon: Settings }
];

export function App() {
  const [activePage, setActivePage] = useState("Traces");
  const [selectedTraceId, setSelectedTraceId] = useState("");
  const [selectedMetricName, setSelectedMetricName] = useState("");
  const [service, setService] = useState("");
  const [query, setQuery] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);

  const health = useQuery({ queryKey: ["health"], queryFn: getHealth });
  const resources = useQuery({ queryKey: ["resources"], queryFn: listResources });
  const traces = useQuery({
    queryKey: ["traces", service, query, errorsOnly],
    queryFn: () => listTraces({ service: service || undefined, q: query || undefined, hasError: errorsOnly ? true : undefined })
  });
  const selectedTrace = useQuery({
    queryKey: ["trace", selectedTraceId],
    queryFn: () => getTrace(selectedTraceId),
    enabled: Boolean(selectedTraceId)
  });
  const logs = useQuery({
    queryKey: ["logs", service, selectedTraceId, query],
    queryFn: () => listLogs({ service: service || undefined, traceId: selectedTraceId || undefined, q: query || undefined })
  });
  const metrics = useQuery({
    queryKey: ["metrics", service, query],
    queryFn: () => listMetrics({ service: service || undefined, q: query || undefined })
  });
  const selectedMetricSeries = useQuery({
    queryKey: ["metric-series", selectedMetricName, service],
    queryFn: () => getMetricSeries(selectedMetricName, service || undefined),
    enabled: Boolean(selectedMetricName)
  });

  useEffect(() => {
    if (!selectedTraceId && traces.data?.[0]) {
      setSelectedTraceId(traces.data[0].traceId);
    }
  }, [selectedTraceId, traces.data]);

  useEffect(() => {
    if (!selectedMetricName && metrics.data?.[0]) {
      setSelectedMetricName(metrics.data[0].metricName);
    }
  }, [metrics.data, selectedMetricName]);

  const serviceNames = useMemo(() => resources.data?.map((item) => item.serviceName) ?? [], [resources.data]);
  const trace = selectedTrace.data;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Activity size={18} />
          </div>
          <div>
            <strong>OTLP Workbench</strong>
            <span>local telemetry</span>
          </div>
        </div>
        <nav className="nav-list" aria-label="Primary">
          {nav.map((item) => (
            <button className={activePage === item.label ? "nav-item active" : "nav-item"} key={item.label} onClick={() => setActivePage(item.label)}>
              <item.icon size={16} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="endpoint-card">
          <span className="label">OTLP/HTTP</span>
          <code>localhost:4318</code>
          <span className="muted">/v1/traces · /v1/logs</span>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div className="toolbar-group search-box">
            <Search size={16} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search traceId, span, log body" />
          </div>
          <div className="toolbar-group">
            <Server size={16} />
            <select value={service} onChange={(event) => setService(event.target.value)}>
              <option value="">All services</option>
              {serviceNames.map((item) => (
                <option value={item} key={item}>{item}</option>
              ))}
            </select>
          </div>
          <button className={errorsOnly ? "toggle active" : "toggle"} onClick={() => setErrorsOnly((value) => !value)}>
            <AlertCircle size={16} />
            Errors
          </button>
          <div className="status-strip">
            <StatusItem icon={Radio} label="ingest" value={health.data?.ok ? "ready" : "checking"} />
            <StatusItem icon={Database} label="storage" value={health.data?.storage ?? "memory"} />
            <StatusItem icon={Clock3} label="window" value="live" />
            <StatusItem icon={RotateCw} label="refresh" value="2s" />
          </div>
        </header>

        <section className="summary-row" aria-label="Telemetry summary">
          <Metric label="Traces" value={health.data?.traces ?? 0} />
          <Metric label="Spans" value={health.data?.spans ?? 0} />
          <Metric label="Logs" value={health.data?.logs ?? 0} />
          <Metric label="Metrics" value={health.data?.metrics ?? 0} />
        </section>

        {activePage === "Metrics" ? (
          <MetricsView
            metrics={metrics.data ?? []}
            selectedMetricName={selectedMetricName}
            onSelect={setSelectedMetricName}
            series={selectedMetricSeries.data ?? []}
          />
        ) : (
          <section className="content-grid">
            <div className="panel trace-list-panel">
              <PanelHeader icon={ListFilter} title="Trace list" meta={`${traces.data?.length ?? 0} traces`} />
              <TraceTable traces={traces.data ?? []} selectedTraceId={selectedTraceId} onSelect={setSelectedTraceId} />
            </div>

            <div className="panel detail-panel">
              <PanelHeader icon={GitBranch} title={trace?.rootName ?? "Trace detail"} meta={trace ? shortId(trace.traceId) : "no trace"} />
              {trace ? (
                <div className="detail-layout">
                  <TraceWaterfall spans={trace.spans} />
                  <SpanInspector spans={trace.spans} />
                </div>
              ) : (
                <EmptyState />
              )}
            </div>

            <div className="panel logs-panel">
              <PanelHeader icon={FileText} title="Correlated logs" meta={`${logs.data?.length ?? 0} rows`} />
              <LogTable logs={logs.data ?? []} />
            </div>

            <div className="panel genai-panel">
              <PanelHeader icon={Sparkles} title="GenAI summary" meta={trace?.genAi.spans.length ? `${trace.genAi.spans.length} spans` : "metadata only"} />
              {trace?.genAi.spans.length ? <GenAiSummary trace={trace} /> : <GenAiEmpty />}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

function StatusItem({ icon: Icon, label, value }: { icon: typeof Radio; label: string; value: string }) {
  return (
    <div className="status-item">
      <Icon size={14} />
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value.toLocaleString()}</strong>
    </div>
  );
}

function PanelHeader({ icon: Icon, title, meta }: { icon: typeof FileText; title: string; meta: string }) {
  return (
    <div className="panel-header">
      <div>
        <Icon size={16} />
        <strong>{title}</strong>
      </div>
      <span>{meta}</span>
    </div>
  );
}

function TraceTable({ traces, selectedTraceId, onSelect }: { traces: TraceSummary[]; selectedTraceId: string; onSelect(traceId: string): void }) {
  if (traces.length === 0) {
    return <EmptyState />;
  }
  return (
    <div className="table trace-table">
      <div className="table-row table-head">
        <span>Root span</span>
        <span>Service</span>
        <span>Duration</span>
        <span>Status</span>
      </div>
      {traces.map((trace) => (
        <button
          className={trace.traceId === selectedTraceId ? "table-row active" : "table-row"}
          key={trace.traceId}
          onClick={() => onSelect(trace.traceId)}
        >
          <span>
            <strong>{trace.rootName}</strong>
            <code>{shortId(trace.traceId)}</code>
          </span>
          <span>{trace.serviceNames.join(", ")}</span>
          <span>{formatDuration(trace.durationNano)}</span>
          <span className={trace.errorCount ? "status-error" : "status-ok"}>{trace.errorCount ? `${trace.errorCount} errors` : "ok"}</span>
        </button>
      ))}
    </div>
  );
}

function TraceWaterfall({ spans }: { spans: Span[] }) {
  const min = Math.min(...spans.map((span) => Number(span.startTimeUnixNano)));
  const max = Math.max(...spans.map((span) => Number(span.endTimeUnixNano)));
  const total = Math.max(1, max - min);

  return (
    <div className="waterfall">
      {spans.map((span) => {
        const left = ((Number(span.startTimeUnixNano) - min) / total) * 100;
        const width = Math.max(1, (span.durationNano / total) * 100);
        return (
          <div className="waterfall-row" key={span.spanId}>
            <span className="span-name">{span.name}</span>
            <div className="bar-track">
              <div className={span.statusCode && span.statusCode >= 2 ? "bar error" : "bar"} style={{ left: `${left}%`, width: `${width}%` }} />
            </div>
            <span className="duration">{formatDuration(span.durationNano)}</span>
          </div>
        );
      })}
    </div>
  );
}

function SpanInspector({ spans }: { spans: Span[] }) {
  const selected = spans[0];
  if (!selected) return null;
  return (
    <div className="inspector">
      <div className="inspector-title">
        <Braces size={15} />
        <strong>Root attributes</strong>
      </div>
      <pre>{JSON.stringify(selected.attributes, null, 2)}</pre>
    </div>
  );
}

function LogTable({ logs }: { logs: LogRecord[] }) {
  if (logs.length === 0) {
    return <EmptyState compact />;
  }
  return (
    <div className="log-list">
      {logs.slice(0, 8).map((log) => (
        <div className="log-row" key={log.id}>
          <span className={severityClass(log.severityText)}>{log.severityText ?? "INFO"}</span>
          <strong>{log.serviceName}</strong>
          <p>{log.bodyText ?? JSON.stringify(log.bodyJson ?? log.attributes)}</p>
          <code>{log.traceId ? shortId(log.traceId) : "no-trace"}</code>
        </div>
      ))}
    </div>
  );
}

function MetricsView({ metrics, selectedMetricName, onSelect, series }: { metrics: MetricDescriptor[]; selectedMetricName: string; onSelect(metricName: string): void; series: MetricSeriesPoint[] }) {
  const selected = metrics.find((metric) => metric.metricName === selectedMetricName);
  return (
    <section className="metrics-grid">
      <div className="panel metrics-list-panel">
        <PanelHeader icon={Gauge} title="Metric instruments" meta={`${metrics.length} metrics`} />
        {metrics.length ? (
          <div className="table metrics-table">
            <div className="metric-row metric-head">
              <span>Name</span>
              <span>Type</span>
              <span>Points</span>
              <span>Attrs</span>
            </div>
            {metrics.map((metric) => (
              <button className={metric.metricName === selectedMetricName ? "metric-row active" : "metric-row"} key={`${metric.serviceName}-${metric.meterName}-${metric.metricName}`} onClick={() => onSelect(metric.metricName)}>
                <span>
                  <strong>{metric.metricName}</strong>
                  <code>{metric.serviceName} · {metric.meterName}</code>
                </span>
                <span>{metric.metricType}</span>
                <span>{metric.pointCount}</span>
                <span>{metric.attributeSets}</span>
              </button>
            ))}
          </div>
        ) : (
          <EmptyState />
        )}
      </div>
      <div className="panel metric-chart-panel">
        <PanelHeader icon={Gauge} title={selected?.metricName ?? "Metric series"} meta={selected?.unit ?? "no unit"} />
        {selected ? <MetricChart series={series} /> : <EmptyState />}
      </div>
    </section>
  );
}

function MetricChart({ series }: { series: MetricSeriesPoint[] }) {
  if (!series.length) {
    return <EmptyState compact />;
  }
  const values = series.map((point) => point.value ?? point.sum ?? point.count ?? 0);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(1, max - min);
  const points = values.map((value, index) => {
    const x = series.length === 1 ? 50 : (index / (series.length - 1)) * 100;
    const y = 90 - ((value - min) / range) * 72;
    return `${x},${y}`;
  }).join(" ");
  return (
    <div className="metric-chart">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="metric series chart">
        <polyline points={points} />
      </svg>
      <div className="chart-footer">
        <span>min {min.toFixed(2)}</span>
        <strong>latest {values[values.length - 1]?.toFixed(2)}</strong>
        <span>max {max.toFixed(2)}</span>
      </div>
    </div>
  );
}

function GenAiSummary({ trace }: { trace: NonNullable<Awaited<ReturnType<typeof getTrace>>> }) {
  const timeline = trace.genAi.timeline.length ? trace.genAi.timeline : trace.genAi.spans.map((span) => ({
    spanId: span.spanId,
    kind: span.kind,
    name: span.name,
    label: span.model ?? span.toolName ?? span.name,
    startTimeUnixNano: "0",
    durationNano: span.durationNano ?? 0,
    status: span.error ? "error" as const : "ok" as const,
    provider: span.provider,
    model: span.model,
    toolName: span.toolName,
    inputTokens: span.inputTokens,
    outputTokens: span.outputTokens
  }));
  return (
    <div className="genai-summary">
      <div className="token-grid">
        <Metric label="Input tokens" value={trace.genAi.inputTokens ?? 0} />
        <Metric label="Output tokens" value={trace.genAi.outputTokens ?? 0} />
        <Metric label="Tool calls" value={trace.genAi.toolCallCount} />
      </div>
      <div className="genai-facts">
        <span>Total {trace.genAi.totalTokens ?? 0} tokens</span>
        <span>Cost {trace.genAi.estimatedCostUsd === undefined ? "n/a" : `$${trace.genAi.estimatedCostUsd.toFixed(5)}`}</span>
        <span>Retrieved docs {trace.genAi.rag.retrievedDocCount}</span>
        <span>Longest {trace.genAi.longestStep ? formatDuration(trace.genAi.longestStep.durationNano) : "n/a"}</span>
      </div>
      <div className="agent-timeline">
        {timeline.map((span) => (
          <div className={span.status === "error" ? "agent-step error" : "agent-step"} key={span.spanId}>
            <MessageSquareCode size={15} />
            <div>
              <strong>{span.kind} · {formatDuration(span.durationNano)}</strong>
              <span>{span.label}</span>
              {(span.inputTokens || span.outputTokens) ? (
                <code>{span.inputTokens ?? 0} in / {span.outputTokens ?? 0} out</code>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function GenAiEmpty() {
  return (
    <div className="empty-state compact">
      <Sparkles size={18} />
      <p>No GenAI spans detected in the selected trace.</p>
    </div>
  );
}

function EmptyState({ compact = false }: { compact?: boolean }) {
  return (
    <div className={compact ? "empty-state compact" : "empty-state"}>
      <Radio size={20} />
      <p>Waiting for OTLP telemetry on <code>localhost:4318</code>.</p>
    </div>
  );
}

function formatDuration(nano: number) {
  const ms = nano / 1_000_000;
  if (ms < 1) return `${(nano / 1_000).toFixed(1)} us`;
  if (ms < 1_000) return `${ms.toFixed(1)} ms`;
  return `${(ms / 1_000).toFixed(2)} s`;
}

function shortId(value: string) {
  return value.length > 12 ? `${value.slice(0, 6)}...${value.slice(-4)}` : value;
}

function severityClass(value: string | undefined) {
  const severity = value?.toLowerCase() ?? "";
  if (severity.includes("error") || severity.includes("fatal")) return "sev error";
  if (severity.includes("warn")) return "sev warn";
  return "sev info";
}
