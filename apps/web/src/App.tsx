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
  Monitor,
  Moon,
  Pause,
  Play,
  Radio,
  RotateCw,
  Search,
  Server,
  Settings,
  Sparkles,
  Sun
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { getHealth, getMetricSeries, getTrace, listLogs, listMetrics, listResources, listTraces, type LogRecord, type MetricDescriptor, type MetricSeriesPoint, type Span, type TraceDetail, type TraceSummary } from "./api.js";

type PageKey = "Traces" | "Logs" | "Metrics" | "GenAI" | "Resources" | "Settings";

const nav: Array<{ label: PageKey; icon: typeof GitBranch; hint: string }> = [
  { label: "Traces", icon: GitBranch, hint: "Distributed traces" },
  { label: "Logs", icon: FileText, hint: "Correlated log stream" },
  { label: "Metrics", icon: Gauge, hint: "OTLP metric series" },
  { label: "GenAI", icon: Sparkles, hint: "LLM & agent timelines" },
  { label: "Resources", icon: Server, hint: "Reporting services" },
  { label: "Settings", icon: Settings, hint: "Endpoints & storage" }
];

const REFRESH_INTERVAL_MS = 2000;
const PAGES_WITHOUT_FILTERS: PageKey[] = ["Resources", "Settings"];

type ThemeMode = "light" | "dark" | "system";
const THEME_STORAGE_KEY = "otlp-theme";

function resolveTheme(mode: ThemeMode): "light" | "dark" {
  if (mode === "system") {
    if (typeof window === "undefined") return "light";
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return mode;
}

function useTheme(): [ThemeMode, (mode: ThemeMode) => void] {
  const [mode, setMode] = useState<ThemeMode>(() => {
    if (typeof window === "undefined") return "system";
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const apply = () => {
      const resolved = resolveTheme(mode);
      document.documentElement.dataset.theme = resolved;
      document.documentElement.style.colorScheme = resolved;
    };
    apply();
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
    if (mode !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [mode]);

  return [mode, setMode];
}

export function App() {
  const [activePage, setActivePage] = useState<PageKey>("Traces");
  const [selectedTraceId, setSelectedTraceId] = useState("");
  const [selectedSpanId, setSelectedSpanId] = useState("");
  const [selectedMetricName, setSelectedMetricName] = useState("");
  const [service, setService] = useState("");
  const [query, setQuery] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [severity, setSeverity] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [themeMode, setThemeMode] = useTheme();

  const refetchInterval = autoRefresh ? REFRESH_INTERVAL_MS : false;

  const health = useQuery({ queryKey: ["health"], queryFn: getHealth, refetchInterval });
  const resources = useQuery({ queryKey: ["resources"], queryFn: listResources, refetchInterval });
  const traces = useQuery({
    queryKey: ["traces", service, query, errorsOnly],
    queryFn: () => listTraces({ service: service || undefined, q: query || undefined, hasError: errorsOnly ? true : undefined }),
    refetchInterval
  });
  const selectedTrace = useQuery({
    queryKey: ["trace", selectedTraceId],
    queryFn: () => getTrace(selectedTraceId),
    enabled: Boolean(selectedTraceId),
    refetchInterval: selectedTraceId ? refetchInterval : false
  });
  const logs = useQuery({
    queryKey: ["logs", service, activePage === "Traces" ? selectedTraceId : "", query, severity],
    queryFn: () => listLogs({
      service: service || undefined,
      traceId: activePage === "Traces" ? selectedTraceId || undefined : undefined,
      q: query || undefined
    }),
    refetchInterval
  });
  const metrics = useQuery({
    queryKey: ["metrics", service, query],
    queryFn: () => listMetrics({ service: service || undefined, q: query || undefined }),
    refetchInterval
  });
  const selectedMetricSeries = useQuery({
    queryKey: ["metric-series", selectedMetricName, service],
    queryFn: () => getMetricSeries(selectedMetricName, service || undefined),
    enabled: Boolean(selectedMetricName),
    refetchInterval: selectedMetricName ? refetchInterval : false
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

  useEffect(() => {
    setSelectedSpanId("");
  }, [selectedTraceId]);

  const serviceNames = useMemo(() => resources.data?.map((item) => item.serviceName) ?? [], [resources.data]);
  const trace = selectedTrace.data;
  const filteredLogs = useMemo(() => {
    const items = logs.data ?? [];
    if (!severity) return items;
    return items.filter((log) => (log.severityText ?? "INFO").toLowerCase().includes(severity.toLowerCase()));
  }, [logs.data, severity]);
  const genAiTraces = useMemo(() => (traces.data ?? []).filter((item) => item.genAiSpanCount > 0), [traces.data]);
  const hideFilters = PAGES_WITHOUT_FILTERS.includes(activePage);

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
            <button
              className={activePage === item.label ? "nav-item active" : "nav-item"}
              key={item.label}
              onClick={() => setActivePage(item.label)}
              title={item.hint}
            >
              <item.icon size={16} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <ThemeSwitch mode={themeMode} onChange={setThemeMode} />
        <div className="endpoint-card">
          <span className="label">OTLP endpoints</span>
          <code>http://localhost:4318</code>
          <code>grpc://localhost:4317</code>
          <span className="muted">/v1/traces · /v1/logs · /v1/metrics</span>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          {!hideFilters && (
            <>
              <div className="toolbar-group search-box">
                <Search size={16} />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={searchPlaceholder(activePage)}
                />
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
              {activePage === "Traces" || activePage === "GenAI" ? (
                <button className={errorsOnly ? "toggle active" : "toggle"} onClick={() => setErrorsOnly((value) => !value)} title="Show traces with errors only">
                  <AlertCircle size={16} />
                  Errors
                </button>
              ) : null}
              {activePage === "Logs" ? (
                <div className="toolbar-group">
                  <AlertCircle size={16} />
                  <select value={severity} onChange={(event) => setSeverity(event.target.value)}>
                    <option value="">All severities</option>
                    <option value="error">Error</option>
                    <option value="warn">Warn</option>
                    <option value="info">Info</option>
                    <option value="debug">Debug</option>
                  </select>
                </div>
              ) : null}
            </>
          )}
          <div className="status-strip">
            <StatusItem icon={Radio} label="ingest" value={health.data?.ok ? "ready" : "checking"} tone={health.data?.ok ? "ok" : "muted"} />
            <StatusItem icon={Database} label="storage" value={health.data?.storage ?? "memory"} />
            <button
              className={autoRefresh ? "status-item toggle-pill active" : "status-item toggle-pill"}
              onClick={() => setAutoRefresh((value) => !value)}
              title={autoRefresh ? "Pause auto-refresh" : "Resume auto-refresh"}
            >
              {autoRefresh ? <Pause size={14} /> : <Play size={14} />}
              <span>refresh</span>
              <strong>{autoRefresh ? `${REFRESH_INTERVAL_MS / 1000}s` : "off"}</strong>
            </button>
            <StatusItem icon={Clock3} label="window" value="live" />
          </div>
        </header>

        <section className="summary-row" aria-label="Telemetry summary">
          <Metric label="Traces" value={health.data?.traces ?? 0} />
          <Metric label="Spans" value={health.data?.spans ?? 0} />
          <Metric label="Logs" value={health.data?.logs ?? 0} />
          <Metric label="Metrics" value={health.data?.metrics ?? 0} />
        </section>

        {activePage === "Traces" ? (
          <TracesPage
            traces={traces.data ?? []}
            tracesLoading={traces.isLoading}
            trace={trace}
            selectedTraceId={selectedTraceId}
            selectedSpanId={selectedSpanId}
            onSelectTrace={setSelectedTraceId}
            onSelectSpan={setSelectedSpanId}
            logs={filteredLogs}
          />
        ) : activePage === "Logs" ? (
          <LogsPage logs={filteredLogs} loading={logs.isLoading} />
        ) : activePage === "Metrics" ? (
          <MetricsView
            metrics={metrics.data ?? []}
            selectedMetricName={selectedMetricName}
            onSelect={setSelectedMetricName}
            series={selectedMetricSeries.data ?? []}
            loading={metrics.isLoading}
          />
        ) : activePage === "GenAI" ? (
          <GenAiPage
            traces={genAiTraces}
            selectedTraceId={selectedTraceId}
            onSelect={setSelectedTraceId}
            trace={trace}
            loading={traces.isLoading}
          />
        ) : activePage === "Resources" ? (
          <ResourcesPage resources={resources.data ?? []} loading={resources.isLoading} />
        ) : (
          <SettingsPage health={health.data} />
        )}
      </main>
    </div>
  );
}

function searchPlaceholder(page: PageKey) {
  switch (page) {
    case "Logs":
      return "Search log body or attributes";
    case "Metrics":
      return "Search metric name or meter";
    case "GenAI":
      return "Search prompt, model or tool";
    default:
      return "Search traceId, span or log body";
  }
}

function ThemeSwitch({ mode, onChange }: { mode: ThemeMode; onChange(mode: ThemeMode): void }) {
  const options: Array<{ id: ThemeMode; label: string; icon: typeof Sun }> = [
    { id: "light", label: "Light", icon: Sun },
    { id: "system", label: "System", icon: Monitor },
    { id: "dark", label: "Dark", icon: Moon }
  ];
  return (
    <div className="theme-switch" role="group" aria-label="Theme">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          className={mode === option.id ? "theme-option active" : "theme-option"}
          onClick={() => onChange(option.id)}
          aria-pressed={mode === option.id}
          title={`${option.label} theme`}
        >
          <option.icon size={14} />
          <span>{option.label}</span>
        </button>
      ))}
    </div>
  );
}

function StatusItem({ icon: Icon, label, value, tone }: { icon: typeof Radio; label: string; value: string; tone?: "ok" | "muted" }) {
  const className = tone === "ok" ? "status-item status-ok-tone" : tone === "muted" ? "status-item status-muted-tone" : "status-item";
  return (
    <div className={className}>
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

function TracesPage({ traces, tracesLoading, trace, selectedTraceId, selectedSpanId, onSelectTrace, onSelectSpan, logs }: {
  traces: TraceSummary[];
  tracesLoading: boolean;
  trace: TraceDetail | undefined;
  selectedTraceId: string;
  selectedSpanId: string;
  onSelectTrace(traceId: string): void;
  onSelectSpan(spanId: string): void;
  logs: LogRecord[];
}) {
  return (
    <section className="content-grid">
      <div className="panel trace-list-panel">
        <PanelHeader icon={ListFilter} title="Trace list" meta={`${traces.length} traces`} />
        <TraceTable traces={traces} selectedTraceId={selectedTraceId} onSelect={onSelectTrace} loading={tracesLoading} />
      </div>

      <div className="panel detail-panel">
        <PanelHeader icon={GitBranch} title={trace?.rootName ?? "Trace detail"} meta={trace ? `${trace.spanCount} spans · ${shortId(trace.traceId)}` : "no trace"} />
        {trace ? (
          <div className="detail-layout">
            <TraceWaterfall spans={trace.spans} selectedSpanId={selectedSpanId} onSelect={onSelectSpan} />
            <SpanInspector spans={trace.spans} selectedSpanId={selectedSpanId} />
          </div>
        ) : (
          <EmptyState scope="trace" />
        )}
      </div>

      <div className="panel logs-panel">
        <PanelHeader icon={FileText} title="Correlated logs" meta={`${logs.length} rows`} />
        <LogTable logs={logs} compact />
      </div>

      <div className="panel genai-panel">
        <PanelHeader icon={Sparkles} title="GenAI summary" meta={trace?.genAi.spans.length ? `${trace.genAi.spans.length} spans` : "metadata only"} />
        {trace?.genAi.spans.length ? <GenAiSummary trace={trace} /> : <GenAiEmpty />}
      </div>
    </section>
  );
}

function LogsPage({ logs, loading }: { logs: LogRecord[]; loading: boolean }) {
  return (
    <section className="single-panel">
      <div className="panel logs-full-panel">
        <PanelHeader icon={FileText} title="Logs" meta={`${logs.length} rows`} />
        {loading && logs.length === 0 ? <EmptyState scope="loading" /> : <LogTable logs={logs} />}
      </div>
    </section>
  );
}

function GenAiPage({ traces, selectedTraceId, onSelect, trace, loading }: {
  traces: TraceSummary[];
  selectedTraceId: string;
  onSelect(traceId: string): void;
  trace: TraceDetail | undefined;
  loading: boolean;
}) {
  return (
    <section className="content-grid genai-grid">
      <div className="panel trace-list-panel">
        <PanelHeader icon={Sparkles} title="GenAI traces" meta={`${traces.length} traces`} />
        {traces.length === 0 ? (
          <EmptyState scope={loading ? "loading" : "genai"} />
        ) : (
          <div className="table trace-table">
            <div className="table-row table-head">
              <span>Root span</span>
              <span>Service</span>
              <span>Tokens</span>
              <span>Spans</span>
            </div>
            {traces.map((item) => (
              <button
                key={item.traceId}
                className={item.traceId === selectedTraceId ? "table-row active" : "table-row"}
                onClick={() => onSelect(item.traceId)}
              >
                <span>
                  <strong>{item.rootName}</strong>
                  <code>{shortId(item.traceId)}</code>
                </span>
                <span>{item.serviceNames.join(", ")}</span>
                <span>{(item.inputTokens ?? 0) + (item.outputTokens ?? 0)}</span>
                <span>{item.genAiSpanCount}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="panel detail-panel">
        <PanelHeader icon={Sparkles} title={trace?.rootName ?? "Agent timeline"} meta={trace ? `${trace.genAi.toolCallCount} tools · ${trace.genAi.totalTokens ?? 0} tokens` : "no trace"} />
        {trace?.genAi.spans.length ? <GenAiSummary trace={trace} /> : <GenAiEmpty />}
      </div>
    </section>
  );
}

function ResourcesPage({ resources, loading }: { resources: Array<{ serviceName: string; spanCount: number; logCount: number; lastSeen: number }>; loading: boolean }) {
  if (loading && resources.length === 0) {
    return (
      <section className="single-panel">
        <div className="panel">
          <PanelHeader icon={Server} title="Reporting services" meta="loading" />
          <EmptyState scope="loading" />
        </div>
      </section>
    );
  }
  if (resources.length === 0) {
    return (
      <section className="single-panel">
        <div className="panel">
          <PanelHeader icon={Server} title="Reporting services" meta="0" />
          <EmptyState scope="resources" />
        </div>
      </section>
    );
  }
  return (
    <section className="resources-grid">
      {resources.map((item) => (
        <div className="resource-card" key={item.serviceName}>
          <div className="resource-head">
            <div className="resource-avatar">{item.serviceName.slice(0, 2).toUpperCase()}</div>
            <div>
              <strong>{item.serviceName}</strong>
              <span>last seen {formatRelative(item.lastSeen)}</span>
            </div>
          </div>
          <div className="resource-stats">
            <div>
              <span>Spans</span>
              <strong>{item.spanCount.toLocaleString()}</strong>
            </div>
            <div>
              <span>Logs</span>
              <strong>{item.logCount.toLocaleString()}</strong>
            </div>
          </div>
        </div>
      ))}
    </section>
  );
}

function SettingsPage({ health }: { health: import("./api.js").Health | undefined }) {
  const endpoints = [
    { label: "Dashboard", value: "http://localhost:18888" },
    { label: "OTLP/HTTP", value: "http://localhost:4318" },
    { label: "OTLP/gRPC", value: "grpc://localhost:4317" }
  ];
  return (
    <section className="settings-grid">
      <div className="panel">
        <PanelHeader icon={Server} title="Endpoints" meta={health?.ok ? "online" : "offline"} />
        <div className="settings-list">
          {endpoints.map((item) => (
            <div className="settings-row" key={item.label}>
              <span>{item.label}</span>
              <code>{item.value}</code>
            </div>
          ))}
        </div>
      </div>
      <div className="panel">
        <PanelHeader icon={Database} title="Storage" meta={health?.storage ?? "memory"} />
        <div className="settings-list">
          <div className="settings-row">
            <span>Traces</span>
            <strong>{(health?.traces ?? 0).toLocaleString()}</strong>
          </div>
          <div className="settings-row">
            <span>Spans</span>
            <strong>{(health?.spans ?? 0).toLocaleString()}</strong>
          </div>
          <div className="settings-row">
            <span>Logs</span>
            <strong>{(health?.logs ?? 0).toLocaleString()}</strong>
          </div>
          <div className="settings-row">
            <span>Metrics points</span>
            <strong>{(health?.metrics ?? 0).toLocaleString()}</strong>
          </div>
          <div className="settings-row">
            <span>Raw batches</span>
            <strong>{(health?.batches ?? 0).toLocaleString()}</strong>
          </div>
        </div>
      </div>
      <div className="panel settings-tips-panel">
        <PanelHeader icon={Sparkles} title="Quick tips" meta="cli" />
        <div className="settings-list">
          <div className="settings-row">
            <span>Send sample</span>
            <code>./examples/otlp-json-smoke.sh</code>
          </div>
          <div className="settings-row">
            <span>Clear data</span>
            <code>pnpm --filter @devdash/cli start -- clear</code>
          </div>
          <div className="settings-row">
            <span>Export</span>
            <code>pnpm --filter @devdash/cli start -- export --out ./telemetry.json</code>
          </div>
        </div>
      </div>
    </section>
  );
}

function TraceTable({ traces, selectedTraceId, onSelect, loading }: { traces: TraceSummary[]; selectedTraceId: string; onSelect(traceId: string): void; loading: boolean }) {
  if (traces.length === 0) {
    return <EmptyState scope={loading ? "loading" : "traces"} />;
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

function TraceWaterfall({ spans, selectedSpanId, onSelect }: { spans: Span[]; selectedSpanId: string; onSelect(spanId: string): void }) {
  const min = Math.min(...spans.map((span) => Number(span.startTimeUnixNano)));
  const max = Math.max(...spans.map((span) => Number(span.endTimeUnixNano)));
  const total = Math.max(1, max - min);
  const depthBySpanId = useMemo(() => computeDepth(spans), [spans]);
  const services = useMemo(() => Array.from(new Set(spans.map((span) => span.serviceName))), [spans]);

  return (
    <div className="waterfall">
      {spans.map((span) => {
        const left = ((Number(span.startTimeUnixNano) - min) / total) * 100;
        const width = Math.max(0.6, (span.durationNano / total) * 100);
        const depth = depthBySpanId.get(span.spanId) ?? 0;
        const colorIndex = services.indexOf(span.serviceName);
        const isError = (span.statusCode ?? 0) >= 2;
        const active = span.spanId === selectedSpanId;
        return (
          <button
            className={active ? "waterfall-row active" : "waterfall-row"}
            key={span.spanId}
            onClick={() => onSelect(span.spanId)}
            title={`${span.serviceName} · ${span.name}`}
          >
            <span className="span-name" style={{ paddingLeft: depth * 12 }}>
              <span className={`service-dot service-color-${colorIndex % 6}`} aria-hidden />
              {span.name}
            </span>
            <div className="bar-track">
              <div
                className={isError ? "bar error" : `bar service-bar-${colorIndex % 6}`}
                style={{ left: `${left}%`, width: `${width}%` }}
              />
            </div>
            <span className="duration">{formatDuration(span.durationNano)}</span>
          </button>
        );
      })}
    </div>
  );
}

function computeDepth(spans: Span[]): Map<string, number> {
  const byId = new Map(spans.map((span) => [span.spanId, span]));
  const cache = new Map<string, number>();
  const visit = (span: Span, guard: Set<string>): number => {
    if (cache.has(span.spanId)) return cache.get(span.spanId)!;
    if (!span.parentSpanId || !byId.has(span.parentSpanId) || guard.has(span.spanId)) {
      cache.set(span.spanId, 0);
      return 0;
    }
    guard.add(span.spanId);
    const depth = visit(byId.get(span.parentSpanId)!, guard) + 1;
    cache.set(span.spanId, depth);
    return depth;
  };
  for (const span of spans) {
    visit(span, new Set());
  }
  return cache;
}

function SpanInspector({ spans, selectedSpanId }: { spans: Span[]; selectedSpanId: string }) {
  const selected = spans.find((span) => span.spanId === selectedSpanId) ?? spans[0];
  if (!selected) return null;
  return (
    <div className="inspector">
      <div className="inspector-title">
        <Braces size={15} />
        <strong>{selected.name}</strong>
        <code>{selected.serviceName}</code>
        <span className="inspector-duration">{formatDuration(selected.durationNano)}</span>
      </div>
      <pre>{JSON.stringify(selected.attributes, null, 2)}</pre>
    </div>
  );
}

function LogTable({ logs, compact = false }: { logs: LogRecord[]; compact?: boolean }) {
  if (logs.length === 0) {
    return <EmptyState scope="logs" compact={compact} />;
  }
  const rows = compact ? logs.slice(0, 8) : logs;
  return (
    <div className="log-list">
      {rows.map((log) => (
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

function MetricsView({ metrics, selectedMetricName, onSelect, series, loading }: { metrics: MetricDescriptor[]; selectedMetricName: string; onSelect(metricName: string): void; series: MetricSeriesPoint[]; loading: boolean }) {
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
          <EmptyState scope={loading ? "loading" : "metrics"} />
        )}
      </div>
      <div className="panel metric-chart-panel">
        <PanelHeader icon={Gauge} title={selected?.metricName ?? "Metric series"} meta={selected?.unit ?? "no unit"} />
        {selected ? <MetricChart series={series} /> : <EmptyState scope="metrics" />}
      </div>
    </section>
  );
}

function MetricChart({ series }: { series: MetricSeriesPoint[] }) {
  if (!series.length) {
    return <EmptyState scope="metrics" compact />;
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
  const areaPoints = `0,90 ${points} 100,90`;
  return (
    <div className="metric-chart">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="metric series chart">
        <polygon className="metric-area" points={areaPoints} />
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

function GenAiSummary({ trace }: { trace: TraceDetail }) {
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
      {trace.genAi.rag.documents.length ? (
        <div className="rag-docs">
          {trace.genAi.rag.documents.map((document, index) => (
            <div className="rag-doc" key={`${document.spanId}-${document.id ?? index}`}>
              <strong>{document.title ?? document.id ?? `Document ${index + 1}`}</strong>
              <span>{document.score === undefined ? "score n/a" : `score ${document.score.toFixed(3)}`}</span>
              {document.contentPreview ? <p>{document.contentPreview}</p> : null}
            </div>
          ))}
        </div>
      ) : null}
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

function EmptyState({ scope = "default", compact = false }: { scope?: "default" | "loading" | "traces" | "logs" | "metrics" | "trace" | "genai" | "resources"; compact?: boolean }) {
  const { icon: Icon, message } = emptyContent(scope);
  return (
    <div className={compact ? "empty-state compact" : "empty-state"}>
      <Icon size={20} />
      <p>{message}</p>
    </div>
  );
}

function emptyContent(scope: string): { icon: typeof Radio; message: React.ReactNode } {
  switch (scope) {
    case "loading":
      return { icon: RotateCw, message: "Loading telemetry…" };
    case "traces":
      return { icon: GitBranch, message: <>No traces yet. Send a span to <code>localhost:4318/v1/traces</code>.</> };
    case "logs":
      return { icon: FileText, message: <>No logs match the current filters.</> };
    case "metrics":
      return { icon: Gauge, message: <>No metric data points yet.</> };
    case "trace":
      return { icon: GitBranch, message: <>Select a trace from the list to inspect spans.</> };
    case "genai":
      return { icon: Sparkles, message: <>No GenAI traces yet. Emit a span with <code>gen_ai.*</code> attributes.</> };
    case "resources":
      return { icon: Server, message: <>No services have reported telemetry yet.</> };
    default:
      return { icon: Radio, message: <>Waiting for OTLP telemetry on <code>localhost:4318</code>.</> };
  }
}

function formatDuration(nano: number) {
  const ms = nano / 1_000_000;
  if (ms < 1) return `${(nano / 1_000).toFixed(1)} us`;
  if (ms < 1_000) return `${ms.toFixed(1)} ms`;
  return `${(ms / 1_000).toFixed(2)} s`;
}

function formatRelative(timestampMs: number) {
  if (!timestampMs) return "never";
  const diff = Date.now() - timestampMs;
  if (diff < 0) return "just now";
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function shortId(value: string) {
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

function severityClass(value: string | undefined) {
  const severity = value?.toLowerCase() ?? "";
  if (severity.includes("error") || severity.includes("fatal")) return "sev error";
  if (severity.includes("warn")) return "sev warn";
  if (severity.includes("debug") || severity.includes("trace")) return "sev debug";
  return "sev info";
}
