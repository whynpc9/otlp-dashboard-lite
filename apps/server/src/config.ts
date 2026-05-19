export interface ServerConfig {
  host: string;
  dashboardPort: number;
  otlpHttpPort: number;
  otlpGrpcPort: number;
  storage: "memory" | "sqlite";
  dbPath: string;
  retentionMs?: number | undefined;
  maxDbSizeBytes?: number | undefined;
  maxTraces?: number | undefined;
  maxMetrics: number;
  webDistDir?: string | undefined;
  maxSpans: number;
  maxLogs: number;
  maxBatches: number;
  maxMetricAttributeSets?: number | undefined;
  maxConcurrentIngest?: number | undefined;
}

export function readConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    host: env("HOST") ?? "127.0.0.1",
    dashboardPort: Number(env("DASHBOARD_PORT") ?? 18888),
    otlpHttpPort: Number(env("OTLP_HTTP_PORT") ?? 4318),
    otlpGrpcPort: Number(env("OTLP_GRPC_PORT") ?? 4317),
    storage: env("STORAGE") === "sqlite" ? "sqlite" : "memory",
    dbPath: env("DB") ?? "./.otel/local-otel-workbench.db",
    retentionMs: env("RETENTION") ? parseDurationMs(env("RETENTION")!) : undefined,
    maxDbSizeBytes: env("MAX_DB_SIZE") ? parseBytes(env("MAX_DB_SIZE")!) : undefined,
    maxTraces: env("MAX_TRACES") ? Number(env("MAX_TRACES")) : undefined,
    webDistDir: env("WEB_DIST"),
    maxSpans: Number(env("MAX_SPANS") ?? 50_000),
    maxLogs: Number(env("MAX_LOGS") ?? 100_000),
    maxMetrics: Number(env("MAX_METRICS") ?? 100_000),
    maxBatches: Number(env("MAX_BATCHES") ?? 1_000),
    maxMetricAttributeSets: Number(env("MAX_METRIC_ATTRIBUTE_SETS") ?? 1_000),
    maxConcurrentIngest: Number(env("MAX_CONCURRENT_INGEST") ?? 4),
    ...overrides
  };
}

function env(name: string): string | undefined {
  return process.env[`LOCAL_OTEL_WORKBENCH_${name}`] ?? process.env[`DEVDASH_${name}`];
}

export function parseDurationMs(value: string): number | undefined {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/);
  if (!match) {
    return undefined;
  }
  const amount = Number(match[1]);
  const unit = match[2] ?? "ms";
  const multiplier = unit === "d" ? 86_400_000 : unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : unit === "s" ? 1_000 : 1;
  return amount * multiplier;
}

export function parseBytes(value: string): number | undefined {
  const match = value.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)(b|kb|mb|gb|tb)?$/);
  if (!match) {
    return undefined;
  }
  const amount = Number(match[1]);
  const unit = match[2] ?? "b";
  const multiplier = unit === "tb" ? 1_099_511_627_776 : unit === "gb" ? 1_073_741_824 : unit === "mb" ? 1_048_576 : unit === "kb" ? 1024 : 1;
  return Math.floor(amount * multiplier);
}
