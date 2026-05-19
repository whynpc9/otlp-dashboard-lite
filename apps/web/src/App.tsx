import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  Bot,
  Boxes,
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  ClipboardCopy,
  Clock3,
  Cog,
  Database,
  Eraser,
  FileText,
  Gauge,
  GitBranch,
  Info,
  MessageSquareCode,
  Monitor,
  Moon,
  PanelsTopLeft,
  Pause,
  Play,
  Radio,
  RotateCw,
  Search,
  Server,
  Settings as SettingsIcon,
  Sparkles,
  Sun,
  Timer,
  User as UserIcon,
  Wrench
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  clearAllData,
  getHealth,
  getMetricSeries,
  getTrace,
  listLogs,
  listMetrics,
  listResources,
  listTraces,
  type Health,
  type LogRecord,
  type MetricDescriptor,
  type MetricSeriesPoint,
  type Span,
  type TraceDetail,
  type TraceSummary
} from "./api.js";

type PageKey = "Resources" | "Logs" | "Traces" | "Metrics" | "GenAI" | "Settings";

const nav: Array<{ id: PageKey; label: string; icon: typeof GitBranch; hint: string }> = [
  { id: "Resources", label: "Resources", icon: PanelsTopLeft, hint: "Services reporting telemetry" },
  { id: "Logs", label: "Structured logs", icon: FileText, hint: "Semantic log stream" },
  { id: "Traces", label: "Traces", icon: GitBranch, hint: "Distributed traces" },
  { id: "Metrics", label: "Metrics", icon: Gauge, hint: "OTLP metric instruments" },
  { id: "GenAI", label: "GenAI", icon: Sparkles, hint: "LLM & agent timelines" },
  { id: "Settings", label: "Settings", icon: SettingsIcon, hint: "Endpoints & storage" }
];

const REFRESH_INTERVAL_MS = 2000;
const STALE_THRESHOLD_MS = 30_000;

type TimeRangeId = "5m" | "15m" | "1h" | "6h" | "24h" | "all";
const TIME_RANGE_STORAGE_KEY = "otlp-time-range";
const TIME_RANGES: Array<{ id: TimeRangeId; label: string; durationMs: number | null }> = [
  { id: "5m", label: "Last 5 minutes", durationMs: 5 * 60_000 },
  { id: "15m", label: "Last 15 minutes", durationMs: 15 * 60_000 },
  { id: "1h", label: "Last 1 hour", durationMs: 60 * 60_000 },
  { id: "6h", label: "Last 6 hours", durationMs: 6 * 60 * 60_000 },
  { id: "24h", label: "Last 24 hours", durationMs: 24 * 60 * 60_000 },
  { id: "all", label: "All time", durationMs: null }
];

function timeRangeMeta(id: TimeRangeId) {
  return TIME_RANGES.find((item) => item.id === id) ?? TIME_RANGES[5]!;
}

function computeFromMillis(id: TimeRangeId): string | undefined {
  const meta = timeRangeMeta(id);
  if (meta.durationMs === null) return undefined;
  return String(Date.now() - meta.durationMs);
}

function useTimeRange(): [TimeRangeId, (id: TimeRangeId) => void] {
  const [range, setRange] = useState<TimeRangeId>(() => {
    if (typeof window === "undefined") return "all";
    const stored = window.localStorage.getItem(TIME_RANGE_STORAGE_KEY);
    if (stored && TIME_RANGES.some((item) => item.id === stored)) return stored as TimeRangeId;
    return "all";
  });
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(TIME_RANGE_STORAGE_KEY, range);
    }
  }, [range]);
  return [range, setRange];
}

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
  const [activePage, setActivePage] = useState<PageKey>("Resources");
  const [selectedTraceId, setSelectedTraceId] = useState("");
  const [selectedSpanId, setSelectedSpanId] = useState("");
  const [selectedMetricKey, setSelectedMetricKey] = useState("");
  const [service, setService] = useState("");
  const [query, setQuery] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [severity, setSeverity] = useState("");
  const [paused, setPaused] = useState(false);
  const [themeMode, setThemeMode] = useTheme();
  const [timeRange, setTimeRange] = useTimeRange();

  const queryClient = useQueryClient();
  const refetchInterval = paused ? false : REFRESH_INTERVAL_MS;

  const health = useQuery({ queryKey: ["health"], queryFn: getHealth, refetchInterval });
  const resources = useQuery({ queryKey: ["resources"], queryFn: listResources, refetchInterval });
  const traces = useQuery({
    queryKey: ["traces", service, query, errorsOnly, timeRange],
    queryFn: () => listTraces({
      service: service || undefined,
      q: query || undefined,
      hasError: errorsOnly ? true : undefined,
      from: computeFromMillis(timeRange)
    }),
    refetchInterval
  });
  const selectedTrace = useQuery({
    queryKey: ["trace", selectedTraceId],
    queryFn: () => getTrace(selectedTraceId),
    enabled: Boolean(selectedTraceId),
    refetchInterval: selectedTraceId && !paused ? REFRESH_INTERVAL_MS : false
  });
  const logs = useQuery({
    queryKey: ["logs", service, query, timeRange],
    queryFn: () => listLogs({
      service: service || undefined,
      q: query || undefined,
      from: computeFromMillis(timeRange)
    }),
    refetchInterval
  });
  const metrics = useQuery({
    queryKey: ["metrics", service, query, timeRange],
    queryFn: () => listMetrics({
      service: service || undefined,
      q: query || undefined,
      from: computeFromMillis(timeRange)
    }),
    refetchInterval
  });
  const selectedMetricSeries = useQuery({
    queryKey: ["metric-series", selectedMetricKey, service, timeRange],
    queryFn: () => {
      const [, , metricName] = selectedMetricKey.split("\u0000");
      return getMetricSeries(metricName ?? "", service || undefined, { from: computeFromMillis(timeRange) });
    },
    enabled: Boolean(selectedMetricKey),
    refetchInterval: selectedMetricKey && !paused ? REFRESH_INTERVAL_MS : false
  });

  const clearData = useMutation({
    mutationFn: clearAllData,
    onSuccess: () => {
      queryClient.invalidateQueries();
      setSelectedTraceId("");
      setSelectedSpanId("");
      setSelectedMetricKey("");
    }
  });

  useEffect(() => {
    setSelectedSpanId("");
  }, [selectedTraceId]);

  useEffect(() => {
    if (!selectedMetricKey && metrics.data?.[0]) {
      const m = metrics.data[0];
      setSelectedMetricKey(`${m.serviceName}\u0000${m.meterName}\u0000${m.metricName}`);
    }
  }, [metrics.data, selectedMetricKey]);

  const serviceNames = useMemo(() => resources.data?.map((item) => item.serviceName) ?? [], [resources.data]);
  const trace = selectedTrace.data;
  const filteredLogs = useMemo(() => {
    const items = logs.data ?? [];
    if (!severity) return items;
    return items.filter((log) => (log.severityText ?? "INFO").toLowerCase().includes(severity.toLowerCase()));
  }, [logs.data, severity]);
  const genAiTraces = useMemo(() => (traces.data ?? []).filter((item) => item.genAiSpanCount > 0), [traces.data]);

  const pageMeta = currentPageMeta(activePage);
  const showTraceDetail = activePage === "Traces" && Boolean(selectedTraceId);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Activity size={18} />
          </div>
          <div>
            <strong>OTel Workbench</strong>
            <span>local telemetry</span>
          </div>
        </div>
        <nav className="nav-list" aria-label="Primary">
          {nav.map((item) => (
            <button
              className={activePage === item.id ? "nav-item active" : "nav-item"}
              key={item.id}
              onClick={() => {
                setActivePage(item.id);
                setSelectedTraceId("");
              }}
              title={item.hint}
            >
              <item.icon size={16} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="endpoint-card">
            <span className="label">OTLP endpoints</span>
            <code>http://localhost:4318</code>
            <code>grpc://localhost:4317</code>
          </div>
        </div>
      </aside>

      <main className="workspace">
        <header className="page-header">
          <div className="page-title-group">
            {showTraceDetail ? (
              <button className="back-button" onClick={() => setSelectedTraceId("")} title="Back to traces">
                <ArrowLeft size={14} />
                <span>Traces</span>
              </button>
            ) : null}
            <div className="page-title">
              <pageMeta.icon size={18} />
              <h1>{showTraceDetail ? trace?.rootName ?? "Trace detail" : pageMeta.title}</h1>
              <span className="page-subtitle">{pageMeta.subtitle}</span>
            </div>
          </div>
          <div className="page-actions">
            <TimeRangeMenu value={timeRange} onChange={setTimeRange} />
            <button
              className={paused ? "icon-button active" : "icon-button"}
              onClick={() => setPaused((value) => !value)}
              title={paused ? "Resume refresh" : "Pause refresh"}
            >
              {paused ? <Play size={14} /> : <Pause size={14} />}
              <span>{paused ? "Paused" : "Live"}</span>
            </button>
            <ThemeSwitch mode={themeMode} onChange={setThemeMode} />
          </div>
        </header>

        {!showTraceDetail && (
          <div className="filter-bar">
            <FilterBar
              page={activePage}
              query={query}
              onQueryChange={setQuery}
              service={service}
              onServiceChange={setService}
              services={serviceNames}
              errorsOnly={errorsOnly}
              onErrorsOnlyChange={setErrorsOnly}
              severity={severity}
              onSeverityChange={setSeverity}
              onClear={() => clearData.mutate()}
              clearing={clearData.isPending}
            />
          </div>
        )}

        <section className="page-content">
          {activePage === "Resources" ? (
            <ResourcesPage
              resources={resources.data ?? []}
              loading={resources.isLoading}
              onOpenLogs={(name) => {
                setService(name);
                setActivePage("Logs");
              }}
              onOpenTraces={(name) => {
                setService(name);
                setActivePage("Traces");
              }}
              onOpenMetrics={(name) => {
                setService(name);
                setActivePage("Metrics");
              }}
            />
          ) : activePage === "Logs" ? (
            <LogsPage logs={filteredLogs} loading={logs.isLoading} onOpenTrace={(traceId) => {
              setSelectedTraceId(traceId);
              setActivePage("Traces");
            }} />
          ) : activePage === "Traces" ? (
            showTraceDetail ? (
              trace ? (
                <TraceDetailPage
                  trace={trace}
                  selectedSpanId={selectedSpanId}
                  onSelectSpan={setSelectedSpanId}
                  onOpenLogs={() => {
                    setQuery(trace.traceId);
                    setActivePage("Logs");
                  }}
                />
              ) : (
                <EmptyPanel icon={RotateCw} title="Loading trace…" />
              )
            ) : (
              <TracesListPage
                traces={traces.data ?? []}
                loading={traces.isLoading}
                onSelect={(id) => setSelectedTraceId(id)}
              />
            )
          ) : activePage === "Metrics" ? (
            <MetricsPage
              metrics={metrics.data ?? []}
              selectedMetricKey={selectedMetricKey}
              onSelect={setSelectedMetricKey}
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
          ) : (
            <SettingsPage health={health.data} />
          )}
        </section>

        <footer className="status-bar">
          <StatusChip icon={Radio} label="ingest" value={health.data?.ok ? "ready" : "offline"} tone={health.data?.ok ? "ok" : "warn"} />
          <StatusChip icon={Database} label="storage" value={health.data?.storage ?? "memory"} />
          <span className="status-divider" />
          <StatusChip icon={Boxes} label="resources" value={(resources.data?.length ?? 0).toLocaleString()} />
          <StatusChip icon={GitBranch} label="traces" value={(health.data?.traces ?? 0).toLocaleString()} />
          <StatusChip icon={CircleDot} label="spans" value={(health.data?.spans ?? 0).toLocaleString()} />
          <StatusChip icon={FileText} label="logs" value={(health.data?.logs ?? 0).toLocaleString()} />
          <StatusChip icon={Gauge} label="metrics" value={(health.data?.metrics ?? 0).toLocaleString()} />
          <span className="status-spacer" />
          <StatusChip icon={Timer} label="window" value={timeRangeMeta(timeRange).label.replace(/^Last /, "")} tone="muted" />
          <StatusChip icon={Clock3} label={paused ? "paused" : "refresh"} value={paused ? "off" : `${REFRESH_INTERVAL_MS / 1000}s`} tone={paused ? "warn" : "muted"} />
        </footer>
      </main>
    </div>
  );
}

function currentPageMeta(page: PageKey): { title: string; subtitle: string; icon: typeof GitBranch } {
  switch (page) {
    case "Resources":
      return { title: "Resources", subtitle: "Reporting services", icon: PanelsTopLeft };
    case "Logs":
      return { title: "Structured logs", subtitle: "Semantic log stream", icon: FileText };
    case "Traces":
      return { title: "Traces", subtitle: "Distributed traces", icon: GitBranch };
    case "Metrics":
      return { title: "Metrics", subtitle: "OTLP instruments", icon: Gauge };
    case "GenAI":
      return { title: "GenAI", subtitle: "LLM & agent timelines", icon: Sparkles };
    case "Settings":
      return { title: "Settings", subtitle: "Endpoints & storage", icon: SettingsIcon };
  }
}

function TimeRangeMenu({ value, onChange }: { value: TimeRangeId; onChange(value: TimeRangeId): void }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const meta = timeRangeMeta(value);

  useEffect(() => {
    if (!open) return;
    const onDocumentClick = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocumentClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocumentClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="time-range" ref={containerRef}>
      <button
        type="button"
        className={open ? "icon-button time-range-trigger open" : "icon-button time-range-trigger"}
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Time range"
      >
        <Timer size={14} />
        <span>{meta.label}</span>
        <ChevronDown size={12} />
      </button>
      {open ? (
        <div className="time-range-menu" role="listbox">
          {TIME_RANGES.map((item) => (
            <button
              key={item.id}
              role="option"
              aria-selected={item.id === value}
              className={item.id === value ? "time-range-option active" : "time-range-option"}
              onClick={() => {
                onChange(item.id);
                setOpen(false);
              }}
            >
              <span>{item.label}</span>
              {item.id === value ? <Check size={13} /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
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
          <option.icon size={13} />
        </button>
      ))}
    </div>
  );
}

function StatusChip({ icon: Icon, label, value, tone }: { icon: typeof Radio; label: string; value: string; tone?: "ok" | "warn" | "muted" }) {
  return (
    <span className={`status-chip${tone ? ` tone-${tone}` : ""}`}>
      <Icon size={12} />
      <span className="status-chip-label">{label}</span>
      <strong>{value}</strong>
    </span>
  );
}

function FilterBar({
  page,
  query,
  onQueryChange,
  service,
  onServiceChange,
  services,
  errorsOnly,
  onErrorsOnlyChange,
  severity,
  onSeverityChange,
  onClear,
  clearing
}: {
  page: PageKey;
  query: string;
  onQueryChange(value: string): void;
  service: string;
  onServiceChange(value: string): void;
  services: string[];
  errorsOnly: boolean;
  onErrorsOnlyChange(value: boolean): void;
  severity: string;
  onSeverityChange(value: string): void;
  onClear(): void;
  clearing: boolean;
}) {
  const showFilters = page !== "Settings" && page !== "Resources";
  return (
    <div className="filter-bar-inner">
      {showFilters ? (
        <>
          <div className="filter-search">
            <Search size={14} />
            <input
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder={searchPlaceholder(page)}
            />
          </div>
          <div className="filter-select">
            <Server size={14} />
            <select value={service} onChange={(event) => onServiceChange(event.target.value)}>
              <option value="">All resources</option>
              {services.map((item) => (
                <option value={item} key={item}>{item}</option>
              ))}
            </select>
            <ChevronDown size={12} />
          </div>
          {page === "Logs" ? (
            <div className="filter-select">
              <AlertCircle size={14} />
              <select value={severity} onChange={(event) => onSeverityChange(event.target.value)}>
                <option value="">All levels</option>
                <option value="error">Error</option>
                <option value="warn">Warn</option>
                <option value="info">Info</option>
                <option value="debug">Debug</option>
              </select>
              <ChevronDown size={12} />
            </div>
          ) : null}
          {page === "Traces" || page === "GenAI" ? (
            <button className={errorsOnly ? "chip-toggle active" : "chip-toggle"} onClick={() => onErrorsOnlyChange(!errorsOnly)}>
              <AlertTriangle size={13} />
              Errors only
            </button>
          ) : null}
        </>
      ) : (
        <div className="filter-placeholder">
          {page === "Resources" ? "All telemetry-reporting resources" : "Local OTel workbench settings"}
        </div>
      )}
      <div className="filter-actions">
        <button className="ghost-button danger" onClick={onClear} disabled={clearing} title="Clear all telemetry">
          <Eraser size={13} />
          <span>{clearing ? "Clearing…" : "Clear data"}</span>
        </button>
      </div>
    </div>
  );
}

function searchPlaceholder(page: PageKey) {
  switch (page) {
    case "Logs":
      return "Filter logs by message, traceId or attribute";
    case "Metrics":
      return "Filter metric or meter name";
    case "GenAI":
      return "Search prompt, model or tool";
    case "Traces":
      return "Filter by trace name, span or traceId";
    default:
      return "Filter";
  }
}

function ResourcesPage({ resources, loading, onOpenLogs, onOpenTraces, onOpenMetrics }: {
  resources: Array<{ serviceName: string; spanCount: number; logCount: number; lastSeen: number }>;
  loading: boolean;
  onOpenLogs(name: string): void;
  onOpenTraces(name: string): void;
  onOpenMetrics(name: string): void;
}) {
  if (loading && resources.length === 0) {
    return <EmptyPanel icon={RotateCw} title="Loading resources…" />;
  }
  if (resources.length === 0) {
    return <EmptyPanel icon={Server} title="No resources yet" body={<>Send a span or log to <code>localhost:4318</code> and the reporting resource will appear here.</>} />;
  }
  return (
    <div className="panel data-grid resources-grid">
      <div className="data-row data-head resources-row">
        <span>Name</span>
        <span>State</span>
        <span>Spans</span>
        <span>Logs</span>
        <span>Last seen</span>
        <span>Actions</span>
      </div>
      {resources.map((item) => {
        const state = resourceState(item.lastSeen);
        return (
          <div className="data-row resources-row" key={item.serviceName}>
            <span className="resource-name">
              <span className="resource-avatar">{item.serviceName.slice(0, 2).toUpperCase()}</span>
              <span className="resource-name-text">
                <strong>{item.serviceName}</strong>
                <code>service</code>
              </span>
            </span>
            <span>
              <StatePill state={state} />
            </span>
            <span className="num">{item.spanCount.toLocaleString()}</span>
            <span className="num">{item.logCount.toLocaleString()}</span>
            <span className="muted">{formatRelative(item.lastSeen)}</span>
            <span className="row-actions">
              <button className="ghost-button" onClick={() => onOpenLogs(item.serviceName)} title="View logs">
                <FileText size={13} />
              </button>
              <button className="ghost-button" onClick={() => onOpenTraces(item.serviceName)} title="View traces">
                <GitBranch size={13} />
              </button>
              <button className="ghost-button" onClick={() => onOpenMetrics(item.serviceName)} title="View metrics">
                <Gauge size={13} />
              </button>
            </span>
          </div>
        );
      })}
    </div>
  );
}

function resourceState(lastSeen: number): "running" | "idle" | "stale" {
  if (!lastSeen) return "stale";
  const diff = Date.now() - lastSeen;
  if (diff < STALE_THRESHOLD_MS) return "running";
  if (diff < STALE_THRESHOLD_MS * 4) return "idle";
  return "stale";
}

function StatePill({ state }: { state: "running" | "idle" | "stale" }) {
  const label = state === "running" ? "Running" : state === "idle" ? "Idle" : "Stale";
  return (
    <span className={`state-pill state-${state}`}>
      <span className="state-dot" />
      {label}
    </span>
  );
}

function LogsPage({ logs, loading, onOpenTrace }: { logs: LogRecord[]; loading: boolean; onOpenTrace(traceId: string): void }) {
  if (loading && logs.length === 0) {
    return <EmptyPanel icon={RotateCw} title="Loading structured logs…" />;
  }
  if (logs.length === 0) {
    return <EmptyPanel icon={FileText} title="No structured logs" body={<>Emit logs to <code>localhost:4318/v1/logs</code> to see them here.</>} />;
  }
  return (
    <div className="panel data-grid logs-grid">
      <div className="data-row data-head logs-row">
        <span>Resource</span>
        <span>Level</span>
        <span>Timestamp</span>
        <span>Message</span>
        <span>Trace</span>
      </div>
      {logs.map((log) => (
        <div className="data-row logs-row" key={log.id}>
          <span className="cell-strong">{log.serviceName}</span>
          <span>
            <span className={severityClass(log.severityText)}>{(log.severityText ?? "INFO").toUpperCase()}</span>
          </span>
          <span className="muted mono">{formatTimestamp(log.timeUnixNano ?? log.observedTimeUnixNano)}</span>
          <span className="cell-message" title={log.bodyText ?? ""}>
            {log.bodyText ?? JSON.stringify(log.bodyJson ?? log.attributes)}
          </span>
          <span>
            {log.traceId ? (
              <button className="link-button" onClick={() => onOpenTrace(log.traceId!)} title="Open trace">
                <GitBranch size={12} />
                <code>{shortId(log.traceId)}</code>
              </button>
            ) : (
              <span className="muted">—</span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

function TracesListPage({ traces, loading, onSelect }: { traces: TraceSummary[]; loading: boolean; onSelect(id: string): void }) {
  const maxDuration = useMemo(() => Math.max(1, ...traces.map((t) => t.durationNano)), [traces]);
  if (loading && traces.length === 0) {
    return <EmptyPanel icon={RotateCw} title="Loading traces…" />;
  }
  if (traces.length === 0) {
    return <EmptyPanel icon={GitBranch} title="No traces yet" body={<>Send a span to <code>localhost:4318/v1/traces</code> to populate the list.</>} />;
  }
  return (
    <div className="panel data-grid traces-grid">
      <div className="data-row data-head traces-row">
        <span>Timestamp</span>
        <span>Name</span>
        <span>Resources</span>
        <span>Spans</span>
        <span>Duration</span>
        <span>Errors</span>
      </div>
      {traces.map((trace) => {
        const portion = trace.durationNano / maxDuration;
        return (
          <button
            className="data-row traces-row clickable"
            key={trace.traceId}
            onClick={() => onSelect(trace.traceId)}
          >
            <span className="muted mono">{formatTimestamp(trace.startTimeUnixNano)}</span>
            <span className="cell-strong">
              <strong>
                {trace.rootName}
                {trace.genAiSpanCount > 0 ? (
                  <Sparkles size={12} className="genai-star" aria-label={`${trace.genAiSpanCount} GenAI spans`} />
                ) : null}
              </strong>
              <code>{shortId(trace.traceId)}</code>
            </span>
            <span className="resource-tags">
              {trace.serviceNames.slice(0, 3).map((name, index) => (
                <span key={name} className={`service-tag service-color-${index % 6}`}>{name}</span>
              ))}
              {trace.serviceNames.length > 3 ? <span className="service-tag">+{trace.serviceNames.length - 3}</span> : null}
            </span>
            <span className="num">{trace.spanCount}</span>
            <span className="duration-cell">
              <DurationRadial portion={portion} />
              <span>{formatDuration(trace.durationNano)}</span>
            </span>
            <span>
              {trace.errorCount ? (
                <span className="error-badge">
                  <AlertTriangle size={12} />
                  {trace.errorCount}
                </span>
              ) : (
                <span className="muted">—</span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function DurationRadial({ portion }: { portion: number }) {
  const ratio = Math.max(0.04, Math.min(1, portion));
  return (
    <span className="duration-radial" style={{ "--ratio": `${ratio * 100}%` } as React.CSSProperties} aria-hidden />
  );
}

function TraceDetailPage({ trace, selectedSpanId, onSelectSpan, onOpenLogs }: {
  trace: TraceDetail;
  selectedSpanId: string;
  onSelectSpan(spanId: string): void;
  onOpenLogs(): void;
}) {
  const depth = useMemo(() => {
    const map = computeDepth(trace.spans);
    let max = 0;
    map.forEach((value) => { if (value > max) max = value; });
    return max + 1;
  }, [trace.spans]);
  const resourceCount = useMemo(() => new Set(trace.spans.map((s) => s.serviceName)).size, [trace.spans]);
  const genAiSpanIds = useMemo(() => new Set(trace.genAi.spans.map((span) => span.spanId)), [trace.genAi.spans]);
  return (
    <div className="trace-detail">
      <div className="trace-info-bar">
        <InfoCell label="Trace ID" value={<code>{shortId(trace.traceId)}</code>} />
        <InfoCell label="Duration" value={formatDuration(trace.durationNano)} />
        <InfoCell label="Resources" value={resourceCount.toString()} />
        <InfoCell label="Depth" value={depth.toString()} />
        <InfoCell label="Total spans" value={trace.spanCount.toString()} />
        <InfoCell label="GenAI spans" value={trace.genAi.spans.length.toString()} tone={trace.genAi.spans.length ? "accent" : undefined} />
        <InfoCell label="Errors" value={(trace.errorCount || 0).toString()} tone={trace.errorCount ? "warn" : undefined} />
        <span className="trace-info-actions">
          <button className="ghost-button" onClick={onOpenLogs}>
            <FileText size={13} />
            <span>View logs</span>
          </button>
        </span>
      </div>
      <div className="panel trace-waterfall-panel">
        <TraceWaterfall spans={trace.spans} selectedSpanId={selectedSpanId} onSelect={onSelectSpan} genAiSpanIds={genAiSpanIds} />
      </div>
      <div className="panel span-detail-panel">
        <SpanDetails trace={trace} selectedSpanId={selectedSpanId} genAiSpanIds={genAiSpanIds} />
      </div>
    </div>
  );
}

function InfoCell({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "warn" | "accent" | undefined }) {
  const className = tone === "warn" ? "info-cell tone-warn" : tone === "accent" ? "info-cell tone-accent" : "info-cell";
  return (
    <div className={className}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function TraceWaterfall({ spans, selectedSpanId, onSelect, genAiSpanIds }: { spans: Span[]; selectedSpanId: string; onSelect(spanId: string): void; genAiSpanIds: Set<string> }) {
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
        const isGenAi = genAiSpanIds.has(span.spanId);
        const active = span.spanId === selectedSpanId;
        return (
          <button
            className={active ? "waterfall-row active" : "waterfall-row"}
            key={span.spanId}
            onClick={() => onSelect(span.spanId)}
            title={`${span.serviceName} · ${span.name}`}
          >
            <span className="span-name" style={{ paddingLeft: depth * 14 }}>
              <span className={`service-dot service-color-${colorIndex % 6}`} aria-hidden />
              <strong>{span.name}</strong>
              {isGenAi ? <Sparkles size={11} className="genai-star" aria-label="GenAI span" /> : null}
              <code>{span.serviceName}</code>
              {isError ? <AlertTriangle size={12} className="span-error-icon" /> : null}
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

type SpanDetailTab = "messages" | "properties" | "events" | "logs";
type ConversationTurn = TraceDetail["genAi"]["conversation"][number];

function SpanDetails({ trace, selectedSpanId, genAiSpanIds }: { trace: TraceDetail; selectedSpanId: string; genAiSpanIds: Set<string> }) {
  const span = trace.spans.find((s) => s.spanId === selectedSpanId) ?? trace.spans[0];
  const spanTurns = useMemo<ConversationTurn[]>(
    () => (span ? trace.genAi.conversation.filter((turn) => turn.spanId === span.spanId) : []),
    [span, trace.genAi.conversation]
  );
  const isGenAi = span ? genAiSpanIds.has(span.spanId) : false;
  const [tab, setTab] = useState<SpanDetailTab>(spanTurns.length > 0 ? "messages" : "properties");

  useEffect(() => {
    setTab(spanTurns.length > 0 ? "messages" : "properties");
  }, [selectedSpanId, spanTurns.length]);

  if (!span) return null;
  const spanLogs = trace.logs.filter((log) => log.spanId === span.spanId);
  const showMessagesTab = isGenAi || spanTurns.length > 0;

  return (
    <>
      <div className="span-detail-header">
        <div>
          {isGenAi ? <Sparkles size={14} className="genai-star" /> : <Braces size={14} />}
          <strong>{span.name}</strong>
          <code>{span.serviceName}</code>
        </div>
        <span className="muted">{formatDuration(span.durationNano)}</span>
      </div>
      <div className="tab-strip">
        {showMessagesTab ? <TabButton active={tab === "messages"} onClick={() => setTab("messages")} label="Messages" count={spanTurns.length} /> : null}
        <TabButton active={tab === "properties"} onClick={() => setTab("properties")} label="Properties" count={Object.keys(span.attributes).length} />
        <TabButton active={tab === "events"} onClick={() => setTab("events")} label="Events" count={span.events.length} />
        <TabButton active={tab === "logs"} onClick={() => setTab("logs")} label="Logs" count={spanLogs.length} />
      </div>
      <div className="tab-content">
        {tab === "messages" ? (
          spanTurns.length === 0 ? (
            <InlineEmpty icon={Sparkles} message="No message content recorded. Set OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true to capture chat messages." />
          ) : (
            <MessagesView turns={spanTurns} />
          )
        ) : tab === "properties" ? (
          <PropertiesTable record={span.attributes} />
        ) : tab === "events" ? (
          span.events.length === 0 ? <InlineEmpty icon={Info} message="No events on this span." /> : (
            <div className="event-list">
              {span.events.map((event, index) => (
                <div className="event-row" key={index}>
                  <pre>{JSON.stringify(event, null, 2)}</pre>
                </div>
              ))}
            </div>
          )
        ) : (
          spanLogs.length === 0 ? <InlineEmpty icon={FileText} message="No logs correlated with this span." /> : (
            <div className="span-log-list">
              {spanLogs.map((log) => (
                <div className="span-log-row" key={log.id}>
                  <span className={severityClass(log.severityText)}>{(log.severityText ?? "INFO").toUpperCase()}</span>
                  <span className="muted mono">{formatTimestamp(log.timeUnixNano)}</span>
                  <p>{log.bodyText ?? JSON.stringify(log.bodyJson ?? log.attributes)}</p>
                </div>
              ))}
            </div>
          )
        )}
      </div>
    </>
  );
}

function MessagesView({ turns }: { turns: ConversationTurn[] }) {
  return (
    <div className="message-list">
      {turns.map((turn, index) => (
        <MessageCard key={`${turn.spanId}-${index}-${turn.kind}-${turn.role}`} turn={turn} />
      ))}
    </div>
  );
}

function MessageCard({ turn }: { turn: ConversationTurn }) {
  const [view, setView] = useState<"preview" | "raw">("preview");
  const [copied, setCopied] = useState(false);
  const meta = messageRoleMeta(turn);
  const isRedacted = turn.contentPreview.startsWith("[redacted");

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(turn.contentPreview);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch (error) {
      // clipboard not available; no-op
    }
  };

  return (
    <article className={`message-card message-${meta.tone}`}>
      <header className="message-header">
        <span className={`message-role-badge tone-${meta.tone}`}>
          <meta.icon size={13} />
          <strong>{meta.label}</strong>
          {turn.name ? <code>{turn.name}</code> : null}
        </span>
        <div className="message-controls">
          <div className="segmented">
            <button type="button" className={view === "preview" ? "active" : ""} onClick={() => setView("preview")}>Preview</button>
            <button type="button" className={view === "raw" ? "active" : ""} onClick={() => setView("raw")}>Raw</button>
          </div>
          <button type="button" className="ghost-button" onClick={onCopy} title="Copy to clipboard">
            <ClipboardCopy size={12} />
            <span>{copied ? "Copied" : "Copy"}</span>
          </button>
        </div>
      </header>
      <div className="message-body">
        {isRedacted ? <p className="message-redacted">{turn.contentPreview}</p> : view === "preview" ? (
          <div className="message-preview">{renderMessagePreview(turn)}</div>
        ) : (
          <pre className="message-raw">{turn.contentPreview}</pre>
        )}
      </div>
    </article>
  );
}

function renderMessagePreview(turn: ConversationTurn): React.ReactNode {
  const text = turn.contentPreview;
  if (turn.kind === "tool-call" || turn.kind === "tool-result") {
    const trimmed = text.trim();
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      try {
        const parsed = JSON.parse(trimmed);
        return <pre className="message-json">{JSON.stringify(parsed, null, 2)}</pre>;
      } catch {
        // fall through
      }
    }
  }
  return text.split(/\n+/).map((paragraph, index) => (
    <p key={index}>{paragraph}</p>
  ));
}

function messageRoleMeta(turn: ConversationTurn): { label: string; icon: typeof Bot; tone: "system" | "user" | "assistant" | "tool-call" | "tool-result" } {
  if (turn.kind === "tool-call") {
    return { label: turn.name ? `Tool · ${turn.name}` : "Tool call", icon: Wrench, tone: "tool-call" };
  }
  if (turn.kind === "tool-result") {
    return { label: turn.name ? `Tool result · ${turn.name}` : "Tool result", icon: Wrench, tone: "tool-result" };
  }
  switch (turn.role) {
    case "system":
      return { label: "System", icon: Cog, tone: "system" };
    case "user":
      return { label: "User", icon: UserIcon, tone: "user" };
    case "assistant":
      return { label: "Assistant", icon: Bot, tone: "assistant" };
    case "tool":
      return { label: turn.name ? `Tool · ${turn.name}` : "Tool", icon: Wrench, tone: "tool-result" };
    default:
      return { label: "Message", icon: MessageSquareCode, tone: "assistant" };
  }
}

function TabButton({ active, onClick, label, count }: { active: boolean; onClick(): void; label: string; count: number }) {
  return (
    <button className={active ? "tab-button active" : "tab-button"} onClick={onClick}>
      <span>{label}</span>
      <span className="tab-count">{count}</span>
    </button>
  );
}

function PropertiesTable({ record }: { record: Record<string, unknown> }) {
  const entries = Object.entries(record);
  if (entries.length === 0) {
    return <InlineEmpty icon={Braces} message="No attributes." />;
  }
  return (
    <div className="props-table">
      {entries.map(([key, value]) => (
        <div className="props-row" key={key}>
          <span className="props-key">{key}</span>
          <span className="props-value">{formatPropValue(value)}</span>
        </div>
      ))}
    </div>
  );
}

function formatPropValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function MetricsPage({ metrics, selectedMetricKey, onSelect, series, loading }: {
  metrics: MetricDescriptor[];
  selectedMetricKey: string;
  onSelect(key: string): void;
  series: MetricSeriesPoint[];
  loading: boolean;
}) {
  const tree = useMemo(() => buildMetricTree(metrics), [metrics]);
  const selected = useMemo(() => {
    if (!selectedMetricKey) return undefined;
    const [serviceName, meterName, metricName] = selectedMetricKey.split("\u0000");
    return metrics.find((m) => m.serviceName === serviceName && m.meterName === meterName && m.metricName === metricName);
  }, [metrics, selectedMetricKey]);

  return (
    <div className="metrics-layout">
      <div className="panel metric-tree-panel">
        <div className="panel-subheader">
          <span>Instruments</span>
          <span className="muted">{metrics.length}</span>
        </div>
        {metrics.length === 0 ? (
          <InlineEmpty icon={loading ? RotateCw : Gauge} message={loading ? "Loading metrics…" : "No metrics ingested yet."} />
        ) : (
          <MetricTree tree={tree} selectedKey={selectedMetricKey} onSelect={onSelect} />
        )}
      </div>
      <div className="panel metric-chart-panel">
        {selected ? (
          <>
            <div className="metric-detail-header">
              <div>
                <strong>{selected.metricName}</strong>
                <code>{selected.serviceName} · {selected.meterName}</code>
              </div>
              <div className="metric-detail-meta">
                <InfoCell label="Type" value={selected.metricType} />
                <InfoCell label="Unit" value={selected.unit ?? "—"} />
                <InfoCell label="Points" value={selected.pointCount.toLocaleString()} />
                <InfoCell label="Series" value={selected.attributeSets.toString()} />
              </div>
            </div>
            <MetricChart series={series} />
            {selected.description ? <p className="metric-description">{selected.description}</p> : null}
          </>
        ) : (
          <InlineEmpty icon={Gauge} message="Select an instrument to view its time series." />
        )}
      </div>
    </div>
  );
}

interface MetricTreeNode {
  service: string;
  meters: Array<{ meter: string; metrics: MetricDescriptor[] }>;
}

function buildMetricTree(metrics: MetricDescriptor[]): MetricTreeNode[] {
  const byService = new Map<string, Map<string, MetricDescriptor[]>>();
  for (const metric of metrics) {
    if (!byService.has(metric.serviceName)) byService.set(metric.serviceName, new Map());
    const meters = byService.get(metric.serviceName)!;
    if (!meters.has(metric.meterName)) meters.set(metric.meterName, []);
    meters.get(metric.meterName)!.push(metric);
  }
  return Array.from(byService.entries()).map(([service, meters]) => ({
    service,
    meters: Array.from(meters.entries()).map(([meter, list]) => ({ meter, metrics: list }))
  }));
}

function MetricTree({ tree, selectedKey, onSelect }: { tree: MetricTreeNode[]; selectedKey: string; onSelect(key: string): void }) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toggle = (key: string) => setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
  return (
    <div className="metric-tree">
      {tree.map((node) => (
        <div className="metric-tree-service" key={node.service}>
          <button className="tree-row tree-service" onClick={() => toggle(node.service)}>
            {collapsed[node.service] ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
            <Server size={13} />
            <strong>{node.service}</strong>
          </button>
          {collapsed[node.service] ? null : node.meters.map((meterGroup) => {
            const meterKey = `${node.service}::${meterGroup.meter}`;
            const meterCollapsed = collapsed[meterKey];
            return (
              <div key={meterKey}>
                <button className="tree-row tree-meter" onClick={() => toggle(meterKey)}>
                  {meterCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                  <span>{meterGroup.meter}</span>
                </button>
                {meterCollapsed ? null : meterGroup.metrics.map((metric) => {
                  const key = `${metric.serviceName}\u0000${metric.meterName}\u0000${metric.metricName}`;
                  return (
                    <button
                      key={key}
                      className={key === selectedKey ? "tree-row tree-metric active" : "tree-row tree-metric"}
                      onClick={() => onSelect(key)}
                    >
                      <Gauge size={11} />
                      <span className="metric-tree-name">{metric.metricName}</span>
                      <span className="metric-tree-type">{metric.metricType}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function MetricChart({ series }: { series: MetricSeriesPoint[] }) {
  if (!series.length) {
    return <InlineEmpty icon={Gauge} message="No data points captured yet." />;
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

function GenAiPage({ traces, selectedTraceId, onSelect, trace, loading }: {
  traces: TraceSummary[];
  selectedTraceId: string;
  onSelect(id: string): void;
  trace: TraceDetail | undefined;
  loading: boolean;
}) {
  if (traces.length === 0) {
    return <EmptyPanel icon={loading ? RotateCw : Sparkles} title={loading ? "Loading GenAI traces…" : "No GenAI traces yet"} body={<>Emit spans with <code>gen_ai.*</code> attributes to populate this view.</>} />;
  }
  return (
    <div className="genai-layout">
      <div className="panel genai-list-panel">
        <div className="panel-subheader">
          <span>GenAI traces</span>
          <span className="muted">{traces.length}</span>
        </div>
        <div className="genai-list">
          {traces.map((item) => (
            <button
              key={item.traceId}
              className={item.traceId === selectedTraceId ? "genai-list-row active" : "genai-list-row"}
              onClick={() => onSelect(item.traceId)}
            >
              <strong>{item.rootName}</strong>
              <code>{shortId(item.traceId)}</code>
              <div className="genai-list-meta">
                <span>{(item.inputTokens ?? 0) + (item.outputTokens ?? 0)} tokens</span>
                <span>{item.genAiSpanCount} spans</span>
                <span>{item.serviceNames.join(", ")}</span>
              </div>
            </button>
          ))}
        </div>
      </div>
      <div className="panel genai-detail-panel">
        {trace?.genAi.spans.length ? <GenAiSummary trace={trace} /> : <InlineEmpty icon={Sparkles} message="Select a GenAI trace to view its agent timeline." />}
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
      <div className="genai-info-bar">
        <InfoCell label="Input tokens" value={(trace.genAi.inputTokens ?? 0).toLocaleString()} />
        <InfoCell label="Output tokens" value={(trace.genAi.outputTokens ?? 0).toLocaleString()} />
        <InfoCell label="Total" value={(trace.genAi.totalTokens ?? 0).toLocaleString()} />
        <InfoCell label="Tool calls" value={trace.genAi.toolCallCount.toString()} />
        <InfoCell label="Retrieved docs" value={trace.genAi.rag.retrievedDocCount.toString()} />
        <InfoCell label="Cost" value={trace.genAi.estimatedCostUsd === undefined ? "n/a" : `$${trace.genAi.estimatedCostUsd.toFixed(5)}`} />
        <InfoCell label="Longest step" value={trace.genAi.longestStep ? formatDuration(trace.genAi.longestStep.durationNano) : "n/a"} />
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

function SettingsPage({ health }: { health: Health | undefined }) {
  const endpoints = [
    { label: "Dashboard", value: "http://localhost:18888" },
    { label: "OTLP/HTTP", value: "http://localhost:4318" },
    { label: "OTLP/gRPC", value: "grpc://localhost:4317" }
  ];
  return (
    <div className="settings-layout">
      <div className="panel">
        <div className="panel-subheader">
          <span>Endpoints</span>
          <span className="muted">{health?.ok ? "online" : "offline"}</span>
        </div>
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
        <div className="panel-subheader">
          <span>Storage</span>
          <span className="muted">{health?.storage ?? "memory"}</span>
        </div>
        <div className="settings-list">
          <div className="settings-row"><span>Traces</span><strong>{(health?.traces ?? 0).toLocaleString()}</strong></div>
          <div className="settings-row"><span>Spans</span><strong>{(health?.spans ?? 0).toLocaleString()}</strong></div>
          <div className="settings-row"><span>Logs</span><strong>{(health?.logs ?? 0).toLocaleString()}</strong></div>
          <div className="settings-row"><span>Metric points</span><strong>{(health?.metrics ?? 0).toLocaleString()}</strong></div>
          <div className="settings-row"><span>Raw batches</span><strong>{(health?.batches ?? 0).toLocaleString()}</strong></div>
        </div>
      </div>
      <div className="panel settings-tips-panel">
        <div className="panel-subheader">
          <span>Quick commands</span>
          <span className="muted">cli</span>
        </div>
        <div className="settings-list">
          <div className="settings-row"><span>Send sample</span><code>./examples/otlp-json-smoke.sh</code></div>
          <div className="settings-row"><span>Clear data</span><code>pnpm --filter local-otel-workbench start -- clear</code></div>
          <div className="settings-row"><span>Export</span><code>pnpm --filter local-otel-workbench start -- export --out ./telemetry.json</code></div>
          <div className="settings-row"><span>Retention</span><code>pnpm --filter local-otel-workbench start -- retention --retention 7d</code></div>
        </div>
      </div>
    </div>
  );
}

function EmptyPanel({ icon: Icon, title, body }: { icon: typeof Radio; title: string; body?: React.ReactNode }) {
  return (
    <div className="panel empty-panel">
      <Icon size={28} />
      <h3>{title}</h3>
      {body ? <p>{body}</p> : null}
    </div>
  );
}

function InlineEmpty({ icon: Icon, message }: { icon: typeof Radio; message: string }) {
  return (
    <div className="inline-empty">
      <Icon size={18} />
      <p>{message}</p>
    </div>
  );
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
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatTimestamp(nano: string | undefined): string {
  if (!nano) return "—";
  const ms = Number(nano) / 1_000_000;
  if (!Number.isFinite(ms)) return "—";
  const date = new Date(ms);
  return date.toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
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
