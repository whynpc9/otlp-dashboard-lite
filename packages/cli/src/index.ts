#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseBytes, parseDurationMs, readConfig, type ServerConfig } from "local-otel-server/config";

const defaultDashboardUrl = "http://127.0.0.1:18888";
const otelCommands = new Set(["logs", "traces", "spans", "resources"]);

const argv = process.argv.slice(2);
if (argv[0] === "--") {
  argv.shift();
}

let [command = "serve", ...args] = argv;
if (command === "otel") {
  command = args.shift() ?? "help";
}

if (command === "serve" || command === "dashboard") {
  const config = parseServeConfig(args);
  const { startServers } = await import("local-otel-server/server");
  const servers = await startServers(config);
  console.log(`Dashboard:      http://${config.host}:${config.dashboardPort}`);
  console.log(`OTLP/gRPC:      http://${config.host}:${config.otlpGrpcPort}`);
  console.log(`OTLP/HTTP:      http://${config.host}:${config.otlpHttpPort}`);
  console.log(`Storage:        ${config.storage}`);

  const shutdown = async () => {
    await servers.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
} else if (command === "clear") {
  const baseUrl = dashboardUrl(args);
  const response = await fetch(`${baseUrl}/api/data`, { method: "DELETE" });
  console.log(await response.text());
} else if (command === "export") {
  const baseUrl = dashboardUrl(args);
  const out = readOption(args, "--out");
  const response = await fetch(`${baseUrl}/api/export`, { method: "POST" });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Export failed: ${response.status} ${text}`);
  }
  if (out) {
    await writeFile(out, text);
    console.log(`Exported telemetry to ${out}`);
  } else {
    console.log(text);
  }
} else if (command === "import") {
  const baseUrl = dashboardUrl(args);
  const file = args.find((arg) => !arg.startsWith("--"));
  if (!file) {
    throw new Error("Usage: otel-workbench import <file>");
  }
  const payload = await readFile(file, "utf8");
  const response = await fetch(`${baseUrl}/api/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload
  });
  console.log(await response.text());
} else if (command === "retention") {
  const baseUrl = dashboardUrl(args);
  const retention = readOption(args, "--retention");
  const response = await fetch(`${baseUrl}/api/retention`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      maxAgeMs: retention ? parseDurationMs(retention) : undefined,
      maxTraces: numberOption(args, "--max-traces"),
      maxLogs: numberOption(args, "--max-logs"),
      maxMetrics: numberOption(args, "--max-metrics"),
      maxDbSizeBytes: bytesOption(args, "--max-db-size")
    })
  });
  console.log(await response.text());
} else if (command === "mcp") {
  const { runMcpServer } = await import("local-otel-server/mcp");
  await runMcpServer({ dashboardUrl: dashboardUrl(args) });
} else if (command === "mcp-http") {
  const host = readOption(args, "--host") ?? "127.0.0.1";
  const port = numberOption(args, "--port") ?? 18889;
  const { runMcpHttpServer } = await import("local-otel-server/mcp");
  await runMcpHttpServer({ dashboardUrl: dashboardUrl(args), host, port });
} else if (command === "open") {
  const baseUrl = dashboardUrl(args);
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  await import("node:child_process").then(({ execFile }) => execFile(opener, [baseUrl]));
} else if (otelCommands.has(command)) {
  await runOtelCommand(command, args);
} else if (command === "help" || command === "--help" || command === "-h") {
  printHelp();
} else {
  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(1);
}

async function runOtelCommand(command: string, args: string[]) {
  const baseUrl = dashboardUrl(args);
  const params = telemetryQuery(args);
  const pathName = command === "resources" ? "/api/resources" : `/api/${command}`;
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const data = await fetchJson<Record<string, unknown>>(`${baseUrl}${pathName}${suffix}`);
  printData(data, command, formatOption(args));
}

function parseServeConfig(args: string[]): ServerConfig {
  const overrides: Partial<ServerConfig> = {};
  assign(overrides, "host", readOption(args, "--host"));
  assign(overrides, "dashboardPort", numberOption(args, "--dashboard-port"));
  assign(overrides, "otlpHttpPort", numberOption(args, "--otlp-http-port"));
  assign(overrides, "otlpGrpcPort", numberOption(args, "--otlp-grpc-port"));
  assign(overrides, "storage", storageOption(args));
  assign(overrides, "dbPath", dbPathOption(args));
  assign(overrides, "maxSpans", numberOption(args, "--max-spans"));
  assign(overrides, "maxLogs", numberOption(args, "--max-logs"));
  assign(overrides, "maxMetrics", numberOption(args, "--max-metrics"));
  assign(overrides, "maxTraces", numberOption(args, "--max-traces"));
  assign(overrides, "maxBatches", numberOption(args, "--max-batches"));
  assign(overrides, "maxMetricAttributeSets", numberOption(args, "--max-metric-attribute-sets"));
  assign(overrides, "maxConcurrentIngest", numberOption(args, "--max-concurrent-ingest"));
  assign(overrides, "retentionMs", durationOption(args, "--retention"));
  assign(overrides, "maxDbSizeBytes", bytesOption(args, "--max-db-size"));
  assign(overrides, "webDistDir", readOption(args, "--web-dist") ?? packagedWebDistDir());
  return readConfig(overrides);
}

function telemetryQuery(args: string[]) {
  const params = new URLSearchParams();
  setParam(params, "service", readOption(args, "--service"));
  setParam(params, "traceId", readOption(args, "--trace-id") ?? readOption(args, "--traceId"));
  setParam(params, "spanId", readOption(args, "--span-id") ?? readOption(args, "--spanId"));
  setParam(params, "severity", readOption(args, "--severity"));
  setParam(params, "q", readOption(args, "--q"));
  setParam(params, "from", readOption(args, "--from"));
  setParam(params, "to", readOption(args, "--to"));
  setParam(params, "limit", readOption(args, "--limit"));
  setParam(params, "cursor", readOption(args, "--cursor"));
  setParam(params, "minDurationMs", readOption(args, "--min-duration-ms") ?? readOption(args, "--minDurationMs"));
  if (hasFlag(args, "--has-error")) {
    setParam(params, "hasError", readOption(args, "--has-error") ?? "true");
  }
  return params;
}

function printData(data: Record<string, unknown>, command: string, format: "json" | "table") {
  if (format === "json") {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (command === "resources") {
    printTable((data.resources as ResourceRow[] | undefined ?? []).map((row) => ({
      service: row.serviceName,
      spans: row.spanCount,
      logs: row.logCount,
      lastSeen: formatUnixMillis(row.lastSeen)
    })));
    return;
  }

  if (command === "traces") {
    printTable((data.traces as TraceRow[] | undefined ?? []).map((row) => ({
      time: formatUnixNano(row.startTimeUnixNano),
      durationMs: Math.round(row.durationNano / 1_000_000),
      services: row.serviceNames.join(","),
      spans: row.spanCount,
      errors: row.errorCount,
      traceId: row.traceId,
      root: row.rootName
    })));
    printCursor(data);
    return;
  }

  if (command === "spans") {
    printTable((data.spans as SpanRow[] | undefined ?? []).map((row) => ({
      time: formatUnixNano(row.startTimeUnixNano),
      durationMs: Math.round(row.durationNano / 1_000_000),
      service: row.serviceName,
      status: row.statusCode ?? "",
      traceId: row.traceId,
      spanId: row.spanId,
      name: row.name
    })));
    printCursor(data);
    return;
  }

  printTable((data.logs as LogRow[] | undefined ?? []).map((row) => ({
    time: formatUnixNano(row.timeUnixNano ?? row.observedTimeUnixNano),
    service: row.serviceName,
    severity: row.severityText ?? row.severityNumber ?? "",
    traceId: row.traceId ?? "",
    spanId: row.spanId ?? "",
    body: row.bodyText ?? JSON.stringify(row.bodyJson ?? "")
  })));
  printCursor(data);
}

function printTable(rows: Array<Record<string, unknown>>) {
  if (rows.length === 0) {
    console.log("(no rows)");
    return;
  }
  const columns = Object.keys(rows[0]!);
  const widths = columns.map((column) => {
    return Math.min(80, Math.max(column.length, ...rows.map((row) => cell(row[column]).length)));
  });
  console.log(columns.map((column, index) => cell(column).padEnd(widths[index]!)).join("  "));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) {
    console.log(columns.map((column, index) => truncate(cell(row[column]), widths[index]!).padEnd(widths[index]!)).join("  "));
  }
}

function printCursor(data: Record<string, unknown>) {
  if (typeof data.nextCursor === "string") {
    console.error(`nextCursor: ${data.nextCursor}`);
  }
}

function formatOption(args: string[]): "json" | "table" {
  const value = (readOption(args, "--format") ?? "table").toLowerCase();
  if (value === "json") {
    return "json";
  }
  if (value === "table" || value === "text") {
    return "table";
  }
  throw new Error(`Unsupported format: ${value}. Use table or Json.`);
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }
  return JSON.parse(text) as T;
}

function dashboardUrl(args: string[]) {
  return (readOption(args, "--dashboard-url") ?? defaultDashboardUrl).replace(/\/$/, "");
}

function packagedWebDistDir(): string | undefined {
  const currentFile = fileURLToPath(import.meta.url);
  const candidate = path.resolve(path.dirname(currentFile), "../web-dist");
  return existsSync(candidate) ? candidate : undefined;
}

function durationOption(args: string[], name: string): number | undefined {
  const value = readOption(args, name);
  return value ? parseDurationMs(value) : undefined;
}

function bytesOption(args: string[], name: string): number | undefined {
  const value = readOption(args, name);
  return value ? parseBytes(value) : undefined;
}

function dbPathOption(args: string[]): string | undefined {
  const value = readOption(args, "--db");
  if (!value) {
    return undefined;
  }
  if (path.isAbsolute(value) || value === ":memory:") {
    return value;
  }
  return path.resolve(process.env.INIT_CWD ?? process.cwd(), value);
}

function storageOption(args: string[]): ServerConfig["storage"] | undefined {
  const value = readOption(args, "--storage");
  if (value === undefined) {
    return undefined;
  }
  if (value === "memory" || value === "sqlite") {
    return value;
  }
  throw new Error(`Unsupported storage: ${value}`);
}

function assign<K extends keyof ServerConfig>(target: Partial<ServerConfig>, key: K, value: ServerConfig[K] | undefined) {
  if (value !== undefined) {
    target[key] = value;
  }
}

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index >= 0) {
    const value = args[index + 1];
    return value && !value.startsWith("--") ? value : undefined;
  }
  const prefix = `${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name) || args.some((arg) => arg.startsWith(`${name}=`));
}

function numberOption(args: string[], name: string): number | undefined {
  const value = readOption(args, name);
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function setParam(params: URLSearchParams, key: string, value: string | undefined) {
  if (value !== undefined && value !== "") {
    params.set(key, value);
  }
}

function formatUnixNano(value: string | undefined) {
  if (!value) {
    return "";
  }
  return new Date(Number(BigInt(value) / 1_000_000n)).toISOString();
}

function formatUnixMillis(value: number | undefined) {
  if (!value) {
    return "";
  }
  return new Date(value).toISOString();
}

function cell(value: unknown) {
  return value === undefined || value === null ? "" : String(value);
}

function truncate(value: string, width: number) {
  return value.length > width ? `${value.slice(0, Math.max(0, width - 3))}...` : value;
}

function printHelp() {
  console.error(`Usage:
  otel-workbench serve [--storage memory|sqlite] [--db ./otel.db]
  otel-workbench otel logs [--dashboard-url ${defaultDashboardUrl}] [--format Json]
  otel-workbench otel traces [--service name] [--has-error] [--format Json]
  otel-workbench otel spans [--trace-id id] [--min-duration-ms 500] [--format Json]
  otel-workbench otel resources [--format Json]
  otel-workbench clear|export|import|retention|mcp|mcp-http|open

Common query options:
  --service <name> --trace-id <id> --span-id <id> --severity <text>
  --q <text> --from <iso-or-unix-ms> --to <iso-or-unix-ms>
  --limit <n> --cursor <nextCursor> --dashboard-url <url> --format table|Json`);
}

interface ResourceRow {
  serviceName: string;
  spanCount: number;
  logCount: number;
  lastSeen: number;
}

interface TraceRow {
  traceId: string;
  rootName: string;
  startTimeUnixNano: string;
  durationNano: number;
  serviceNames: string[];
  spanCount: number;
  errorCount: number;
}

interface SpanRow {
  traceId: string;
  spanId: string;
  serviceName: string;
  name: string;
  startTimeUnixNano: string;
  durationNano: number;
  statusCode?: number;
}

interface LogRow {
  traceId?: string;
  spanId?: string;
  serviceName: string;
  severityNumber?: number;
  severityText?: string;
  timeUnixNano?: string;
  observedTimeUnixNano?: string;
  bodyText?: string;
  bodyJson?: unknown;
}
