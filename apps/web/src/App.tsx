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
  Brain,
  ClipboardCopy,
  Code2,
  Clock3,
  Cog,
  Database,
  Download,
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
  Wrench,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
type ThemeMode = "light" | "dark" | "system";
type SortDirection = "asc" | "desc";
const TIME_RANGE_STORAGE_KEY = "otlp-time-range";
const TIME_RANGES: Array<{ id: TimeRangeId; label: string; durationMs: number | null }> = [
  { id: "5m", label: "Last 5 minutes", durationMs: 5 * 60_000 },
  { id: "15m", label: "Last 15 minutes", durationMs: 15 * 60_000 },
  { id: "1h", label: "Last 1 hour", durationMs: 60 * 60_000 },
  { id: "6h", label: "Last 6 hours", durationMs: 6 * 60 * 60_000 },
  { id: "24h", label: "Last 24 hours", durationMs: 24 * 60 * 60_000 },
  { id: "all", label: "All time", durationMs: null }
];
const DEFAULT_TIME_RANGE: TimeRangeId = "all";
const THEME_OPTIONS: Array<{ id: ThemeMode; label: string; icon: typeof Sun }> = [
  { id: "light", label: "Light", icon: Sun },
  { id: "system", label: "System", icon: Monitor },
  { id: "dark", label: "Dark", icon: Moon }
];
const SETTINGS_ENDPOINTS = [
  { label: "Dashboard", value: "http://localhost:18888" },
  { label: "OTLP/HTTP", value: "http://localhost:4318" },
  { label: "OTLP/gRPC", value: "grpc://localhost:4317" }
];

function timeRangeMeta(id: TimeRangeId) {
  return TIME_RANGES.find((item) => item.id === id) ?? TIME_RANGES[5]!;
}

function computeFromMillis(id: TimeRangeId): string | undefined {
  const meta = timeRangeMeta(id);
  if (meta.durationMs === null) return undefined;
  return String(Date.now() - meta.durationMs);
}

function useCopyFeedback(durationMs = 1200) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
  }, []);

  const copy = async (text: string) => {
    if (!text) return false;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setCopied(false), durationMs);
      return true;
    } catch {
      return false;
    }
  };

  return { copy, copied };
}

function CopyButton({
  value,
  label = "Copy",
  size = 13,
  className = ""
}: {
  value: string;
  label?: string;
  size?: number;
  className?: string;
}) {
  const { copy, copied } = useCopyFeedback();

  return (
    <button
      type="button"
      className={`copy-button ${className}`.trim()}
      onClick={(event) => {
        event.stopPropagation();
        void copy(value);
      }}
      title={copied ? "Copied" : label}
      aria-label={copied ? "Copied" : label}
      disabled={!value}
    >
      {copied ? <Check size={size} /> : <ClipboardCopy size={size} />}
    </button>
  );
}

function CopyableCode({
  value,
  display,
  copyLabel,
  className = ""
}: {
  value: string;
  display?: ReactNode;
  copyLabel?: string;
  className?: string;
}) {
  if (!value) {
    return <span className="muted">—</span>;
  }

  return (
    <span className={`copyable-value ${className}`.trim()}>
      <code title={value}>{display ?? value}</code>
      <CopyButton value={value} label={copyLabel ?? "Copy"} />
    </span>
  );
}

function useTimeRange(): [TimeRangeId, (id: TimeRangeId) => void] {
  const [range, setRange] = useState<TimeRangeId>(() => {
    if (typeof window === "undefined") return DEFAULT_TIME_RANGE;
    try {
      const stored = window.localStorage.getItem(TIME_RANGE_STORAGE_KEY);
      if (stored && TIME_RANGES.some((item) => item.id === stored)) return stored as TimeRangeId;
    } catch {
      // Storage may be unavailable in restricted browser contexts.
    }
    return DEFAULT_TIME_RANGE;
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(TIME_RANGE_STORAGE_KEY, range);
    } catch {
      // Storage may be unavailable in restricted browser contexts.
    }
  }, [range]);
  return [range, setRange];
}

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
    try {
      const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
      return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
    } catch {
      return "system";
    }
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const apply = () => {
      const resolved = resolveTheme(mode);
      document.documentElement.dataset.theme = resolved;
      document.documentElement.style.colorScheme = resolved;
    };
    apply();
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, mode);
    } catch {
      // Storage may be unavailable in restricted browser contexts.
    }
    if (mode !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [mode]);

  return [mode, setMode];
}

// Anthropic-style 4-spoke radial spike mark — the brand wordmark prefix.
function SpikeMark({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 1.5c.55 4.05 1.4 6.55 2.6 7.9 1.2 1.3 3.7 2.15 7.9 2.6-4.2.45-6.7 1.3-7.9 2.6-1.2 1.35-2.05 3.85-2.6 7.9-.55-4.05-1.4-6.55-2.6-7.9-1.2-1.3-3.7-2.15-7.9-2.6 4.2-.45 6.7-1.3 7.9-2.6 1.2-1.35 2.05-3.85 2.6-7.9z" />
    </svg>
  );
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
  const [jsonPreview, setJsonPreview] = useState<JsonPreviewState | null>(null);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);

  const openJsonPreview = useCallback((filename: string, data: unknown) => {
    setJsonPreview({ filename, data });
  }, []);

  const openTraceJsonPreview = useCallback(async (traceId: string, fallback?: TraceSummary) => {
    const filename = `trace-${safeFileName(traceId)}.json`;
    setJsonPreview({ filename, loading: true });
    try {
      const trace = await getTrace(traceId);
      setJsonPreview({ filename, data: trace ?? fallback ?? { traceId } });
    } catch {
      setJsonPreview({ filename, data: fallback ?? { traceId } });
    }
  }, []);

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
      const [, meterName, metricName] = selectedMetricKey.split("\u0000");
      return getMetricSeries(metricName ?? "", service || undefined, { meterName, from: computeFromMillis(timeRange) });
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
      setClearConfirmOpen(false);
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
            <SpikeMark />
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
            {SETTINGS_ENDPOINTS.filter((item) => item.label.startsWith("OTLP")).map((item) => (
              <div className="endpoint-row" key={item.label}>
                <code title={item.value}>{item.value}</code>
                <CopyButton value={item.value} label={`Copy ${item.label}`} size={12} />
              </div>
            ))}
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
              <pageMeta.icon size={20} />
              <h1>{showTraceDetail ? trace?.rootName ?? "Trace detail" : pageMeta.title}</h1>
              {showTraceDetail ? (
                trace ? (
                  <span className="page-subtitle">
                    <CopyableCode value={trace.traceId} display={shortId(trace.traceId)} copyLabel="Copy trace ID" />
                  </span>
                ) : null
              ) : (
                <span className="page-subtitle">{pageMeta.subtitle}</span>
              )}
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
              onClear={() => setClearConfirmOpen(true)}
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
              onPreviewJson={openJsonPreview}
            />
          ) : activePage === "Logs" ? (
            <LogsPage
              logs={filteredLogs}
              loading={logs.isLoading}
              onOpenTrace={(traceId) => {
                setSelectedTraceId(traceId);
                setActivePage("Traces");
              }}
              onPreviewJson={openJsonPreview}
            />
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
                onPreviewJson={openTraceJsonPreview}
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
              onOpenInTraces={(id) => {
                setSelectedTraceId(id);
                setActivePage("Traces");
              }}
              onOpenLogs={(traceId) => {
                setQuery(traceId);
                setActivePage("Logs");
              }}
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

      {jsonPreview ? (
        <JsonPreviewModal preview={jsonPreview} onClose={() => setJsonPreview(null)} />
      ) : null}

      {clearConfirmOpen ? (
        <ConfirmDialog
          title="Clear all telemetry?"
          message="This permanently removes all traces, logs, metrics, and resources from local storage. This cannot be undone."
          confirmLabel="Clear data"
          danger
          loading={clearData.isPending}
          onConfirm={() => clearData.mutate()}
          onClose={() => {
            if (!clearData.isPending) setClearConfirmOpen(false);
          }}
        />
      ) : null}
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
  return (
    <div className="theme-switch" role="group" aria-label="Theme">
      {THEME_OPTIONS.map((option) => (
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

function ResourcesPage({ resources, loading, onOpenLogs, onOpenTraces, onOpenMetrics, onPreviewJson }: {
  resources: Array<{ serviceName: string; spanCount: number; logCount: number; lastSeen: number }>;
  loading: boolean;
  onOpenLogs(name: string): void;
  onOpenTraces(name: string): void;
  onOpenMetrics(name: string): void;
  onPreviewJson(filename: string, data: unknown): void;
}) {
  const [timestampSort, setTimestampSort] = useState<SortDirection>("desc");
  const sortedResources = useMemo(
    () => sortByTimestamp(resources, timestampSort, (item) => item.lastSeen),
    [resources, timestampSort]
  );
  if (loading && resources.length === 0) {
    return <EmptyPanel icon={RotateCw} title="Loading resources…" />;
  }
  if (resources.length === 0) {
    return <EmptyPanel icon={Server} title="No resources yet" body={<>Send a span or log to <code>localhost:4318</code> and the reporting resource will appear here.</>} />;
  }
  return (
    <div className="panel data-grid resources-grid">
      <div className="data-row data-head resources-row">
        <span>Resource</span>
        <span>State</span>
        <span>Spans</span>
        <span>Logs</span>
        <SortHeader direction={timestampSort} onToggle={() => setTimestampSort(toggleSortDirection)}>
          Timestamp
        </SortHeader>
        <span>Actions</span>
      </div>
      {sortedResources.map((item) => {
        const state = resourceState(item.lastSeen);
        return (
          <div className="data-row resources-row" key={item.serviceName}>
            <ResourceCell names={[item.serviceName]} showKind />
            <span>
              <StatePill state={state} />
            </span>
            <span className="num">{item.spanCount.toLocaleString()}</span>
            <span className="num">{item.logCount.toLocaleString()}</span>
            <span className="muted mono timestamp-cell" title={formatRelative(item.lastSeen)}>{formatTimestampMs(item.lastSeen)}</span>
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
              <button
                className="ghost-button"
                onClick={() => onPreviewJson(`resource-${safeFileName(item.serviceName)}.json`, item)}
                title="Preview JSON"
              >
                <Braces size={13} />
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

function ResourceCell({ names, showKind = false }: { names: string[]; showKind?: boolean }) {
  const primary = names[0];
  if (!primary) {
    return <span className="muted">—</span>;
  }
  const extra = names.length - 1;
  return (
    <span className="resource-name">
      <span className="resource-avatar" aria-hidden="true">
        {primary.slice(0, 2).toUpperCase()}
      </span>
      <span className="resource-name-text">
        <strong title={names.length > 1 ? names.join(", ") : primary}>{primary}</strong>
        {showKind ? (
          <code>service</code>
        ) : extra > 0 ? (
          <span className="resource-more">{extra === 1 ? "+1 more" : `+${extra} more`}</span>
        ) : null}
      </span>
    </span>
  );
}

function LogsPage({ logs, loading, onOpenTrace, onPreviewJson }: {
  logs: LogRecord[];
  loading: boolean;
  onOpenTrace(traceId: string): void;
  onPreviewJson(filename: string, data: unknown): void;
}) {
  const [timestampSort, setTimestampSort] = useState<SortDirection>("desc");
  const sortedLogs = useMemo(
    () => sortByTimestamp(logs, timestampSort, (log) => nanoToMillis(log.timeUnixNano ?? log.observedTimeUnixNano)),
    [logs, timestampSort]
  );
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
        <SortHeader direction={timestampSort} onToggle={() => setTimestampSort(toggleSortDirection)}>
          Timestamp
        </SortHeader>
        <span>Message</span>
        <span>TraceId</span>
        <span>Actions</span>
      </div>
      {sortedLogs.map((log) => (
        <div className="data-row logs-row" key={log.id}>
          <ResourceCell names={[log.serviceName]} />
          <span>
            <span className={severityClass(log.severityText)}>{(log.severityText ?? "INFO").toUpperCase()}</span>
          </span>
          <span className="muted mono timestamp-cell">{formatTimestamp(log.timeUnixNano ?? log.observedTimeUnixNano)}</span>
          <span className="cell-message" title={log.bodyText ?? ""}>
            {log.bodyText ?? JSON.stringify(log.bodyJson ?? log.attributes)}
          </span>
          <span>
            {log.traceId ? (
              <span className="copyable-value trace-id-cell">
                <button className="link-button" onClick={() => onOpenTrace(log.traceId!)} title="Open trace">
                  <GitBranch size={12} />
                  <code>{shortId(log.traceId)}</code>
                </button>
                <CopyButton value={log.traceId} label="Copy trace ID" size={12} />
              </span>
            ) : (
              <span className="muted">—</span>
            )}
          </span>
          <span className="row-actions">
            <button
              className="ghost-button"
              onClick={() => onPreviewJson(`log-${log.id}.json`, log)}
              title="Preview JSON"
            >
              <Braces size={13} />
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}

function TracesListPage({ traces, loading, onSelect, onPreviewJson }: {
  traces: TraceSummary[];
  loading: boolean;
  onSelect(id: string): void;
  onPreviewJson(traceId: string, fallback?: TraceSummary): void;
}) {
  const [timestampSort, setTimestampSort] = useState<SortDirection>("desc");
  const sortedTraces = useMemo(
    () => sortByTimestamp(traces, timestampSort, (trace) => nanoToMillis(trace.startTimeUnixNano)),
    [traces, timestampSort]
  );
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
        <SortHeader direction={timestampSort} onToggle={() => setTimestampSort(toggleSortDirection)}>
          Timestamp
        </SortHeader>
        <span>TraceId</span>
        <span>Name</span>
        <span>Resource</span>
        <span>Spans</span>
        <span>Duration</span>
        <span>Errors</span>
        <span>Actions</span>
      </div>
      {sortedTraces.map((trace) => {
        const portion = trace.durationNano / maxDuration;
        return (
          <div
            className="data-row traces-row clickable"
            key={trace.traceId}
            onClick={() => onSelect(trace.traceId)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect(trace.traceId);
              }
            }}
            role="button"
            tabIndex={0}
          >
            <span className="muted mono timestamp-cell">{formatTimestamp(trace.startTimeUnixNano)}</span>
            <CopyableCode value={trace.traceId} display={shortId(trace.traceId)} copyLabel="Copy trace ID" />
            <span className="cell-strong">
              <strong>
                {trace.rootName}
                {trace.genAiSpanCount > 0 ? (
                  <Sparkles size={12} className="genai-star" aria-label={`${trace.genAiSpanCount} GenAI spans`} />
                ) : null}
              </strong>
            </span>
            <ResourceCell names={trace.serviceNames} />
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
            <span className="row-actions">
              <button
                className="ghost-button"
                onClick={(event) => {
                  event.stopPropagation();
                  void onPreviewJson(trace.traceId, trace);
                }}
                title="Preview JSON"
              >
                <Braces size={13} />
              </button>
            </span>
          </div>
        );
      })}
    </div>
  );
}

function SortHeader({ children, direction, onToggle }: { children: React.ReactNode; direction: SortDirection; onToggle(): void }) {
  return (
    <button className="sort-button active" onClick={onToggle} title={`Sort ${direction === "asc" ? "descending" : "ascending"}`}>
      <span>{children}</span>
      <ChevronDown size={12} className={direction === "asc" ? "sort-icon asc" : "sort-icon desc"} />
    </button>
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
        <InfoCell
          label="Trace ID"
          value={<CopyableCode value={trace.traceId} display={shortId(trace.traceId)} copyLabel="Copy trace ID" />}
        />
        <InfoCell label="Duration" value={formatDuration(trace.durationNano)} />
        <InfoCell label="Resource count" value={resourceCount.toString()} />
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
  const serviceIndexByName = useMemo(() => {
    const entries = Array.from(new Set(spans.map((span) => span.serviceName))).map((serviceName, index) => [serviceName, index] as const);
    return new Map(entries);
  }, [spans]);

  return (
    <div className="waterfall">
      {spans.map((span) => {
        const left = ((Number(span.startTimeUnixNano) - min) / total) * 100;
        const width = Math.max(0.6, (span.durationNano / total) * 100);
        const depth = depthBySpanId.get(span.spanId) ?? 0;
        const colorIndex = serviceIndexByName.get(span.serviceName) ?? 0;
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
  const spanById = useMemo(() => new Map(trace.spans.map((item) => [item.spanId, item])), [trace.spans]);
  const span = spanById.get(selectedSpanId) ?? trace.spans[0];
  const spanTurns = useMemo<ConversationTurn[]>(
    () => (span ? trace.genAi.conversation.filter((turn) => turn.spanId === span.spanId) : []),
    [span?.spanId, trace.genAi.conversation]
  );
  const spanLogs = useMemo(() => (span ? trace.logs.filter((log) => log.spanId === span.spanId) : []), [span?.spanId, trace.logs]);
  const isGenAi = span ? genAiSpanIds.has(span.spanId) : false;
  const [tab, setTab] = useState<SpanDetailTab>(spanTurns.length > 0 ? "messages" : "properties");

  useEffect(() => {
    setTab(spanTurns.length > 0 ? "messages" : "properties");
  }, [selectedSpanId, spanTurns.length]);

  if (!span) return null;
  const showMessagesTab = isGenAi || spanTurns.length > 0;

  return (
    <>
      <div className="span-detail-header">
        <div>
          {isGenAi ? <Sparkles size={14} className="genai-star" /> : <Braces size={14} />}
          <strong>{span.name}</strong>
          <code>{span.serviceName}</code>
          <CopyableCode
            value={span.spanId}
            display={shortId(span.spanId)}
            copyLabel="Copy span ID"
            className="span-id-chip"
          />
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

type CopyMode = "plain" | "escaped";

function MessageCard({ turn }: { turn: ConversationTurn }) {
  const [view, setView] = useState<"preview" | "raw">("preview");
  const [copied, setCopied] = useState<CopyMode | null>(null);
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const meta = messageRoleMeta(turn);
  const hasContent = turn.contentPreview.length > 0;
  const isRedacted = hasContent && turn.contentPreview.startsWith("[redacted");
  const reasoning = turn.reasoningPreview ?? "";
  const hasReasoning = reasoning.length > 0;

  useEffect(() => () => {
    if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
  }, []);

  const copyText = async (mode: CopyMode) => {
    const payload = mode === "escaped" ? JSON.stringify(turn.contentPreview) : turn.contentPreview;
    try {
      await navigator.clipboard.writeText(payload);
      setCopied(mode);
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = setTimeout(() => setCopied(null), 1200);
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
          {hasReasoning ? (
            <span className="message-reasoning-tag" title="This message includes reasoning / chain-of-thought content">
              <Brain size={11} />
              <span>reasoning</span>
            </span>
          ) : null}
        </span>
        <div className="message-controls">
          <div className="segmented">
            <button type="button" className={view === "preview" ? "active" : ""} onClick={() => setView("preview")}>Preview</button>
            <button type="button" className={view === "raw" ? "active" : ""} onClick={() => setView("raw")}>Raw</button>
          </div>
          <button
            type="button"
            className="ghost-button"
            onClick={() => copyText("plain")}
            disabled={!hasContent}
            title={hasContent ? "Copy content text (excludes reasoning)" : "No content to copy"}
          >
            <ClipboardCopy size={12} />
            <span>{copied === "plain" ? "Copied" : "Copy"}</span>
          </button>
          <button
            type="button"
            className="ghost-button"
            onClick={() => copyText("escaped")}
            disabled={!hasContent}
            title={hasContent
              ? 'Copy content as quoted/escaped string literal (e.g. "hello\\nworld") — paste straight into source code. Excludes reasoning.'
              : "No content to copy"}
          >
            <Code2 size={12} />
            <span>{copied === "escaped" ? "Copied" : "Copy as string"}</span>
          </button>
        </div>
      </header>
      {hasReasoning ? (
        <section className={reasoningOpen ? "message-reasoning open" : "message-reasoning"}>
          <button
            type="button"
            className="message-reasoning-header"
            onClick={() => setReasoningOpen((value) => !value)}
            aria-expanded={reasoningOpen}
          >
            <span className="message-reasoning-title">
              <Brain size={12} />
              <strong>Reasoning</strong>
              <span className="muted">· chain of thought</span>
            </span>
            <span className="message-reasoning-toggle">
              {reasoningOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              <span>{reasoningOpen ? "Hide" : "Show"}</span>
            </span>
          </button>
          {reasoningOpen ? <pre className="message-reasoning-body">{reasoning}</pre> : null}
        </section>
      ) : null}
      <div className="message-body">
        {hasContent ? (
          isRedacted ? <p className="message-redacted">{turn.contentPreview}</p> : view === "preview" ? (
            <div className="message-preview">{renderMessagePreview(turn)}</div>
          ) : (
            <pre className="message-raw">{turn.contentPreview}</pre>
          )
        ) : (
          <p className="message-empty muted">No content. Expand reasoning above to view the chain of thought.</p>
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
          <span className="props-value">
            <span className="props-value-text">{formatPropValue(value)}</span>
            {formatPropValue(value) !== "—" ? (
              <CopyButton value={formatPropValue(value)} label={`Copy ${key}`} size={12} />
            ) : null}
          </span>
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
  const metricsByKey = useMemo(() => {
    return new Map(metrics.map((metric) => [metricKey(metric), metric]));
  }, [metrics]);
  const selected = useMemo(() => {
    if (!selectedMetricKey) return undefined;
    return metricsByKey.get(selectedMetricKey);
  }, [metricsByKey, selectedMetricKey]);

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
                  const key = metricKey(metric);
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

function GenAiPage({ traces, selectedTraceId, onSelect, trace, loading, onOpenInTraces, onOpenLogs }: {
  traces: TraceSummary[];
  selectedTraceId: string;
  onSelect(id: string): void;
  trace: TraceDetail | undefined;
  loading: boolean;
  onOpenInTraces(id: string): void;
  onOpenLogs(traceId: string): void;
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
          {traces.map((item) => {
            const startMs = Number(item.startTimeUnixNano) / 1_000_000;
            return (
              <button
                key={item.traceId}
                className={item.traceId === selectedTraceId ? "genai-list-row active" : "genai-list-row"}
                onClick={() => onSelect(item.traceId)}
              >
                <div className="genai-list-title">
                  <strong>{item.rootName}</strong>
                  {item.errorCount ? <AlertTriangle size={11} className="genai-list-error" aria-label="trace has errors" /> : null}
                  <span className="genai-list-span-count">
                    <Sparkles size={10} className="genai-star" aria-hidden />
                    {item.genAiSpanCount}
                  </span>
                </div>
                <div className="genai-list-meta">
                  <CopyableCode
                    value={item.traceId}
                    display={shortId(item.traceId)}
                    copyLabel="Copy trace ID"
                    className="genai-trace-id"
                  />
                  <span>·</span>
                  <span>{formatDuration(item.durationNano)}</span>
                  <span>·</span>
                  <span>{formatRelative(startMs)}</span>
                </div>
                <div className="genai-list-bottom">
                  <span className="genai-list-tokens">
                    <span className="muted">in</span>
                    <strong>{(item.inputTokens ?? 0).toLocaleString()}</strong>
                    <span className="muted">out</span>
                    <strong>{(item.outputTokens ?? 0).toLocaleString()}</strong>
                  </span>
                  <span className="genai-list-services">
                    {item.serviceNames.slice(0, 2).map((name, index) => (
                      <span key={name} className={`service-tag service-color-${index % 6}`}>{name}</span>
                    ))}
                    {item.serviceNames.length > 2 ? <span className="service-tag">+{item.serviceNames.length - 2}</span> : null}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </div>
      <div className="panel genai-detail-panel">
        {trace?.genAi.spans.length ? (
          <GenAiDetail key={trace.traceId} trace={trace} onOpenInTraces={onOpenInTraces} onOpenLogs={onOpenLogs} />
        ) : (
          <InlineEmpty icon={Sparkles} message="Select a GenAI trace to inspect its conversation, steps and retrieved documents." />
        )}
      </div>
    </div>
  );
}

type GenAiTab = "steps" | "messages" | "rag" | "tools";

function GenAiDetail({ trace, onOpenInTraces, onOpenLogs }: {
  trace: TraceDetail;
  onOpenInTraces(id: string): void;
  onOpenLogs(traceId: string): void;
}) {
  const primary = useMemo(() => derivePrimaryModel(trace), [trace]);
  const conversation = trace.genAi.conversation;
  const toolStats = useMemo(() => aggregateToolStats(trace), [trace]);
  const rag = trace.genAi.rag;
  const stepCount = trace.genAi.timeline.length || trace.genAi.spans.length;
  const [tab, setTab] = useState<GenAiTab>(conversation.length > 0 ? "messages" : "steps");

  return (
    <div className="genai-detail">
      <header className="genai-detail-header">
        <div className="genai-detail-title">
          <span className="genai-detail-icon">
            <Sparkles size={14} className="genai-star" />
          </span>
          <div>
            <strong>{trace.rootName}</strong>
            <div className="genai-detail-sub">
              {primary.model ? <code className="genai-model-badge">{primary.model}</code> : null}
              {primary.provider ? <span className="muted">{primary.provider}</span> : null}
              <CopyableCode
                value={trace.traceId}
                display={shortId(trace.traceId)}
                copyLabel="Copy trace ID"
                className="genai-detail-trace-id"
              />
              <span className="muted">·</span>
              <span className="muted">{formatDuration(trace.durationNano)}</span>
              {trace.errorCount ? (
                <span className="genai-detail-error">
                  <AlertTriangle size={11} />
                  {trace.errorCount} error{trace.errorCount === 1 ? "" : "s"}
                </span>
              ) : null}
            </div>
          </div>
        </div>
        <div className="genai-detail-actions">
          <button className="ghost-button" onClick={() => onOpenLogs(trace.traceId)} title="View correlated logs">
            <FileText size={13} />
            <span>Logs</span>
          </button>
          <button className="ghost-button" onClick={() => onOpenInTraces(trace.traceId)} title="Open trace waterfall">
            <GitBranch size={13} />
            <span>Open in Traces</span>
          </button>
        </div>
      </header>

      <div className="genai-kpi-bar">
        <KpiCell
          label="Tokens"
          primary={(trace.genAi.totalTokens ?? 0).toLocaleString()}
          secondary={`${(trace.genAi.inputTokens ?? 0).toLocaleString()} in · ${(trace.genAi.outputTokens ?? 0).toLocaleString()} out`}
        />
        <KpiCell
          label="Cost"
          primary={trace.genAi.estimatedCostUsd === undefined ? "—" : `$${trace.genAi.estimatedCostUsd.toFixed(5)}`}
          secondary={trace.genAi.estimatedCostUsd === undefined ? "no pricing" : "estimated"}
        />
        <KpiCell
          label="Tool calls"
          primary={trace.genAi.toolCallCount.toLocaleString()}
          secondary={trace.genAi.failedToolCallCount ? `${trace.genAi.failedToolCallCount} failed` : "all ok"}
          tone={trace.genAi.failedToolCallCount ? "warn" : undefined}
        />
        <KpiCell
          label="Retrieval"
          primary={rag.retrievedDocCount.toLocaleString()}
          secondary={`${rag.retrievalSpanCount} retr · ${rag.embeddingSpanCount} embed${rag.rerankSpanCount ? ` · ${rag.rerankSpanCount} rerank` : ""}`}
        />
      </div>

      <div className="tab-strip genai-tab-strip">
        <TabButton active={tab === "messages"} onClick={() => setTab("messages")} label="Messages" count={conversation.length} />
        <TabButton active={tab === "steps"} onClick={() => setTab("steps")} label="Steps" count={stepCount} />
        <TabButton active={tab === "rag"} onClick={() => setTab("rag")} label="RAG" count={rag.documents.length || rag.retrievedDocCount} />
        <TabButton active={tab === "tools"} onClick={() => setTab("tools")} label="Tools" count={toolStats.length} />
      </div>

      <div className="genai-tab-content">
        {tab === "messages" ? (
          conversation.length === 0 ? (
            <InlineEmpty icon={MessageSquareCode} message="No message content recorded. Set OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true to capture chat messages." />
          ) : (
            <MessagesView turns={conversation} />
          )
        ) : tab === "steps" ? (
          <GenAiSteps trace={trace} />
        ) : tab === "rag" ? (
          <RagPanel rag={rag} />
        ) : (
          <ToolsPanel stats={toolStats} />
        )}
      </div>
    </div>
  );
}

function KpiCell({ label, primary, secondary, tone }: {
  label: string;
  primary: string;
  secondary?: string | undefined;
  tone?: "warn" | "accent" | undefined;
}) {
  const cls = tone === "warn" ? "kpi-cell tone-warn" : tone === "accent" ? "kpi-cell tone-accent" : "kpi-cell";
  return (
    <div className={cls}>
      <span className="kpi-label">{label}</span>
      <strong className="kpi-primary">{primary}</strong>
      {secondary ? <span className="kpi-secondary">{secondary}</span> : null}
    </div>
  );
}

function derivePrimaryModel(trace: TraceDetail): { model?: string; provider?: string } {
  const counts = new Map<string, { count: number; provider?: string | undefined }>();
  for (const span of trace.genAi.spans) {
    if (!span.model) continue;
    const entry = counts.get(span.model) ?? { count: 0, provider: span.provider };
    entry.count += 1;
    if (!entry.provider && span.provider) entry.provider = span.provider;
    counts.set(span.model, entry);
  }
  let best: { model: string; count: number; provider?: string | undefined } | undefined;
  counts.forEach((entry, model) => {
    if (!best || entry.count > best.count) best = { model, count: entry.count, provider: entry.provider };
  });
  if (!best) return {};
  const result: { model?: string; provider?: string } = { model: best.model };
  if (best.provider) result.provider = best.provider;
  return result;
}

interface StepRow {
  spanId: string;
  kind: string;
  label: string;
  startMs: number;
  durationMs: number;
  durationNano: number;
  status: "ok" | "error";
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  toolName?: string | undefined;
}

function buildGenAiSteps(trace: TraceDetail): StepRow[] {
  if (trace.genAi.timeline.length > 0) {
    return trace.genAi.timeline
      .map<StepRow>((t) => ({
        spanId: t.spanId,
        kind: t.kind,
        label: t.label,
        startMs: Number(t.startTimeUnixNano) / 1_000_000,
        durationMs: t.durationNano / 1_000_000,
        durationNano: t.durationNano,
        status: t.status,
        inputTokens: t.inputTokens,
        outputTokens: t.outputTokens,
        provider: t.provider,
        model: t.model,
        toolName: t.toolName
      }))
      .sort((a, b) => a.startMs - b.startMs);
  }
  return trace.genAi.spans.map<StepRow>((s) => ({
    spanId: s.spanId,
    kind: s.kind,
    label: s.model ?? s.toolName ?? s.name,
    startMs: 0,
    durationMs: (s.durationNano ?? 0) / 1_000_000,
    durationNano: s.durationNano ?? 0,
    status: s.error ? "error" : "ok",
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    provider: s.provider,
    model: s.model,
    toolName: s.toolName
  }));
}

function GenAiSteps({ trace }: { trace: TraceDetail }) {
  const steps = useMemo(() => buildGenAiSteps(trace), [trace]);
  if (steps.length === 0) {
    return <InlineEmpty icon={Sparkles} message="No GenAI steps captured for this trace." />;
  }
  const min = steps[0]!.startMs;
  const end = steps.reduce((m, s) => Math.max(m, s.startMs + s.durationMs), min);
  const span = Math.max(1, end - min);
  return (
    <div className="genai-steps">
      {steps.map((step, index) => {
        const meta = stepKindMeta(step.kind);
        const left = ((step.startMs - min) / span) * 100;
        const width = Math.max(1.2, (step.durationMs / span) * 100);
        return (
          <div className={step.status === "error" ? "genai-step error" : "genai-step"} key={`${step.spanId}-${index}`}>
            <span className="genai-step-index">{index + 1}</span>
            <span className={`genai-step-icon kind-${meta.tone}`} aria-hidden>
              <meta.icon size={13} />
            </span>
            <div className="genai-step-body">
              <div className="genai-step-title">
                <strong>{step.label || step.kind}</strong>
                <code className={`genai-step-kind kind-${meta.tone}`}>{step.kind}</code>
                {step.toolName && step.toolName !== step.label ? <span className="muted">· {step.toolName}</span> : null}
                {step.status === "error" ? <AlertTriangle size={11} className="span-error-icon" /> : null}
              </div>
              <div className="genai-step-track" aria-hidden>
                <span className={`genai-step-bar kind-${meta.tone}${step.status === "error" ? " error" : ""}`} style={{ left: `${left}%`, width: `${width}%` }} />
              </div>
              <div className="genai-step-meta">
                <span><Timer size={10} /> {formatDuration(step.durationNano)}</span>
                {(step.inputTokens || step.outputTokens) ? (
                  <span>{(step.inputTokens ?? 0).toLocaleString()} in / {(step.outputTokens ?? 0).toLocaleString()} out</span>
                ) : null}
                {step.model && step.model !== step.label ? <span>{step.model}</span> : null}
                {step.provider ? <span className="muted">{step.provider}</span> : null}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function stepKindMeta(kind: string): { icon: typeof Bot; tone: string } {
  const k = (kind || "").toLowerCase();
  if (k.includes("tool")) return { icon: Wrench, tone: "tool" };
  if (k.includes("embed")) return { icon: Activity, tone: "embed" };
  if (k.includes("rerank")) return { icon: Activity, tone: "rerank" };
  if (k.includes("retriev") || k.includes("rag") || k.includes("search")) return { icon: Database, tone: "retrieval" };
  if (k.includes("agent")) return { icon: Sparkles, tone: "agent" };
  if (k.includes("chat") || k.includes("completion") || k.includes("llm") || k.includes("text_generation")) return { icon: Bot, tone: "llm" };
  return { icon: MessageSquareCode, tone: "default" };
}

function RagPanel({ rag }: { rag: TraceDetail["genAi"]["rag"] }) {
  if (rag.documents.length === 0 && rag.retrievalSpanCount === 0 && rag.embeddingSpanCount === 0 && rag.rerankSpanCount === 0) {
    return <InlineEmpty icon={Database} message="No RAG retrieval recorded for this trace." />;
  }
  return (
    <div className="rag-panel">
      <div className="rag-stats">
        <KpiCell label="Retrieved docs" primary={rag.retrievedDocCount.toLocaleString()} />
        <KpiCell label="Retrieval spans" primary={rag.retrievalSpanCount.toLocaleString()} />
        <KpiCell label="Embedding spans" primary={rag.embeddingSpanCount.toLocaleString()} />
        <KpiCell label="Rerank spans" primary={rag.rerankSpanCount.toLocaleString()} />
      </div>
      {rag.documents.length > 0 ? (
        <div className="rag-doc-list">
          {rag.documents.map((doc, index) => (
            <article className="rag-doc-card" key={`${doc.spanId}-${doc.id ?? index}`}>
              <header className="rag-doc-header">
                <span className="rag-doc-rank">#{index + 1}</span>
                <strong>{doc.title ?? doc.id ?? `Document ${index + 1}`}</strong>
                {typeof doc.score === "number" ? <span className="rag-doc-score">score {doc.score.toFixed(3)}</span> : null}
              </header>
              {doc.contentPreview ? <p className="rag-doc-preview">{doc.contentPreview}</p> : <p className="rag-doc-preview muted">No content preview captured.</p>}
              <footer className="rag-doc-footer muted mono">
                <span>{shortId(doc.spanId)}</span>
                {doc.id ? <span>· {doc.id}</span> : null}
              </footer>
            </article>
          ))}
        </div>
      ) : (
        <InlineEmpty icon={FileText} message="Retrieval ran but no document payloads were captured." />
      )}
    </div>
  );
}

interface ToolStat {
  toolName: string;
  count: number;
  failed: number;
  totalDurationNano: number;
}

function aggregateToolStats(trace: TraceDetail): ToolStat[] {
  const map = new Map<string, ToolStat>();
  for (const span of trace.genAi.spans) {
    if (!span.toolName) continue;
    const entry = map.get(span.toolName) ?? { toolName: span.toolName, count: 0, failed: 0, totalDurationNano: 0 };
    entry.count += 1;
    if (span.error) entry.failed += 1;
    entry.totalDurationNano += span.durationNano ?? 0;
    map.set(span.toolName, entry);
  }
  return Array.from(map.values()).sort((a, b) => b.count - a.count);
}

function ToolsPanel({ stats }: { stats: ToolStat[] }) {
  if (stats.length === 0) {
    return <InlineEmpty icon={Wrench} message="No tool calls in this trace." />;
  }
  const maxCount = Math.max(1, ...stats.map((s) => s.count));
  return (
    <div className="tools-panel">
      {stats.map((stat) => {
        const portion = stat.count / maxCount;
        const avg = stat.totalDurationNano / Math.max(1, stat.count);
        return (
          <div className={stat.failed > 0 ? "tool-row has-failed" : "tool-row"} key={stat.toolName}>
            <div className="tool-row-head">
              <Wrench size={12} />
              <strong>{stat.toolName}</strong>
              <span className="muted">avg {formatDuration(avg)}</span>
            </div>
            <div className="tool-row-bar" aria-hidden>
              <span className="tool-row-fill" style={{ width: `${Math.max(4, portion * 100)}%` }} />
            </div>
            <div className="tool-row-meta">
              <span><strong>{stat.count}</strong> call{stat.count === 1 ? "" : "s"}</span>
              {stat.failed > 0 ? <span className="tool-row-failed"><AlertTriangle size={10} /> {stat.failed} failed</span> : <span className="muted">all ok</span>}
              <span className="muted">total {formatDuration(stat.totalDurationNano)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SettingsPage({ health }: { health: Health | undefined }) {
  return (
    <div className="settings-layout">
      <div className="panel">
        <div className="panel-subheader">
          <span>Endpoints</span>
          <span className="muted">{health?.ok ? "online" : "offline"}</span>
        </div>
        <div className="settings-list">
          {SETTINGS_ENDPOINTS.map((item) => (
            <div className="settings-row" key={item.label}>
              <span>{item.label}</span>
              <div className="settings-row-value">
                <code title={item.value}>{item.value}</code>
                <CopyButton value={item.value} label={`Copy ${item.label}`} size={12} />
              </div>
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
          {[
            { label: "Send sample", value: "./examples/otlp-json-smoke.sh" },
            { label: "Clear data", value: "pnpm --filter local-otel-workbench start -- clear" },
            { label: "Export", value: "pnpm --filter local-otel-workbench start -- export --out ./telemetry.json" },
            { label: "Retention", value: "pnpm --filter local-otel-workbench start -- retention --retention 7d" }
          ].map((item) => (
            <div className="settings-row" key={item.label}>
              <span>{item.label}</span>
              <div className="settings-row-value">
                <code title={item.value}>{item.value}</code>
                <CopyButton value={item.value} label={`Copy ${item.label} command`} size={12} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function metricKey(metric: Pick<MetricDescriptor, "serviceName" | "meterName" | "metricName">): string {
  return `${metric.serviceName}\u0000${metric.meterName}\u0000${metric.metricName}`;
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

function toggleSortDirection(direction: SortDirection): SortDirection {
  return direction === "asc" ? "desc" : "asc";
}

function sortByTimestamp<T>(items: T[], direction: SortDirection, getTimestampMs: (item: T) => number): T[] {
  const factor = direction === "asc" ? 1 : -1;
  return [...items].sort((a, b) => {
    const left = normalizedSortTimestamp(getTimestampMs(a));
    const right = normalizedSortTimestamp(getTimestampMs(b));
    return (left - right) * factor;
  });
}

function normalizedSortTimestamp(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function formatTimestamp(nano: string | undefined): string {
  return formatTimestampMs(nanoToMillis(nano));
}

function formatTimestampMs(ms: number | undefined): string {
  if (!ms || !Number.isFinite(ms)) return "—";
  const date = new Date(ms!);
  return [
    date.getFullYear(),
    padDatePart(date.getMonth() + 1),
    padDatePart(date.getDate())
  ].join("-") + ` ${padDatePart(date.getHours())}:${padDatePart(date.getMinutes())}:${padDatePart(date.getSeconds())}`;
}

function padDatePart(value: number): string {
  return value.toString().padStart(2, "0");
}

function nanoToMillis(nano: string | undefined): number {
  if (!nano) return 0;
  const ms = Number(nano) / 1_000_000;
  return Number.isFinite(ms) ? ms : 0;
}

type JsonPreviewState = {
  filename: string;
  data?: unknown;
  loading?: boolean;
  error?: string;
};

function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel = "Cancel",
  danger = false,
  loading = false,
  onConfirm,
  onClose
}: {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm(): void;
  onClose(): void;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !loading) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose, loading]);

  return (
    <div className="confirm-overlay" onClick={() => !loading && onClose()} role="presentation">
      <div
        className="confirm-dialog"
        onClick={(event) => event.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-message"
      >
        <h3 id="confirm-dialog-title">{title}</h3>
        <p id="confirm-dialog-message">{message}</p>
        <footer className="confirm-dialog-footer">
          <button type="button" className="json-preview-action" onClick={onClose} disabled={loading}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={danger ? "json-preview-action confirm-danger" : "json-preview-action"}
            onClick={onConfirm}
            disabled={loading}
          >
            {loading ? "Clearing…" : confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}

function JsonPreviewModal({ preview, onClose }: { preview: JsonPreviewState; onClose(): void }) {
  const [copied, setCopied] = useState(false);
  const jsonText = preview.data !== undefined ? JSON.stringify(preview.data, null, 2) : "";
  const lines = jsonText ? jsonText.split("\n") : [];
  const canUseData = !preview.loading && preview.data !== undefined && !preview.error;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  async function handleCopy() {
    if (!canUseData) return;
    await navigator.clipboard.writeText(jsonText);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="json-preview-overlay" onClick={onClose} role="presentation">
      <div
        className="json-preview-dialog"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="json-preview-title"
      >
        <header className="json-preview-header">
          <div className="json-preview-title" id="json-preview-title">
            <FileText size={16} />
            <strong>{preview.filename}</strong>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className="json-preview-scroll">
          {preview.loading ? (
            <div className="json-preview-loading">
              <RotateCw size={18} />
              <span>Loading JSON…</span>
            </div>
          ) : preview.error ? (
            <p className="json-preview-error">{preview.error}</p>
          ) : (
            <pre className="json-preview-code">
              {lines.map((line, index) => (
                <div className="json-preview-line" key={index}>
                  <span className="json-preview-ln">{index + 1}</span>
                  <code className="json-preview-text">{highlightJsonLine(line)}</code>
                </div>
              ))}
            </pre>
          )}
        </div>

        <footer className="json-preview-footer">
          <button
            type="button"
            className="json-preview-action"
            disabled={!canUseData}
            onClick={() => exportJsonFile(preview.filename, preview.data)}
          >
            <Download size={14} />
            <span>Download</span>
          </button>
          <button type="button" className="json-preview-action" disabled={!canUseData} onClick={() => void handleCopy()}>
            {copied ? <Check size={14} /> : <ClipboardCopy size={14} />}
            <span>{copied ? "Copied" : "Copy to clipboard"}</span>
          </button>
        </footer>
      </div>
    </div>
  );
}

function highlightJsonLine(line: string): ReactNode {
  if (!line.trim()) {
    return line || "\u00a0";
  }

  const keyValue = /^(\s*)("(?:\\.|[^"\\])*")(\s*:\s*)(.*)$/.exec(line);
  if (keyValue) {
    const indent = keyValue[1] ?? "";
    const key = keyValue[2] ?? "";
    const colon = keyValue[3] ?? "";
    const rest = keyValue[4] ?? "";
    return (
      <>
        {indent}
        <span className="json-hl-key">{key}</span>
        {colon}
        {highlightJsonValue(rest)}
      </>
    );
  }

  return highlightJsonValue(line);
}

function highlightJsonValue(fragment: string): ReactNode {
  const trimmed = fragment.trim();
  if (!trimmed) {
    return fragment;
  }

  const leading = fragment.slice(0, fragment.indexOf(trimmed));
  const trailing = fragment.slice(fragment.indexOf(trimmed) + trimmed.length);

  if (/^"(?:\\.|[^"\\])*"$/.test(trimmed)) {
    return (
      <>
        {leading}
        <span className="json-hl-string">{trimmed}</span>
        {trailing}
      </>
    );
  }
  if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed)) {
    return (
      <>
        {leading}
        <span className="json-hl-number">{trimmed}</span>
        {trailing}
      </>
    );
  }
  if (/^(true|false|null)$/.test(trimmed)) {
    return (
      <>
        {leading}
        <span className="json-hl-literal">{trimmed}</span>
        {trailing}
      </>
    );
  }

  return fragment;
}

function exportJsonFile(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function safeFileName(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "resource";
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
