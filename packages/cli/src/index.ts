#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseBytes, parseDurationMs, readConfig, type ServerConfig } from "@devdash/server/config";
import { startServers } from "@devdash/server/server";

const argv = process.argv.slice(2);
if (argv[0] === "--") {
  argv.shift();
}
const [command = "serve", ...args] = argv;

if (command === "serve") {
  const config = parseServeConfig(args);
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
  const baseUrl = readOption(args, "--dashboard-url") ?? "http://127.0.0.1:18888";
  const response = await fetch(`${baseUrl}/api/data`, { method: "DELETE" });
  console.log(await response.text());
} else if (command === "export") {
  const baseUrl = readOption(args, "--dashboard-url") ?? "http://127.0.0.1:18888";
  const out = readOption(args, "--out");
  const response = await fetch(`${baseUrl}/api/export`, { method: "POST" });
  const text = await response.text();
  if (out) {
    await writeFile(out, text);
    console.log(`Exported telemetry to ${out}`);
  } else {
    console.log(text);
  }
} else if (command === "import") {
  const baseUrl = readOption(args, "--dashboard-url") ?? "http://127.0.0.1:18888";
  const file = args.find((arg) => !arg.startsWith("--"));
  if (!file) {
    throw new Error("Usage: devdash import <file>");
  }
  const payload = await readFile(file, "utf8");
  const response = await fetch(`${baseUrl}/api/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload
  });
  console.log(await response.text());
} else if (command === "retention") {
  const baseUrl = readOption(args, "--dashboard-url") ?? "http://127.0.0.1:18888";
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
  const dashboardUrl = readOption(args, "--dashboard-url") ?? "http://127.0.0.1:18888";
  const { runMcpServer } = await import("@devdash/server/mcp");
  await runMcpServer({ dashboardUrl });
} else if (command === "mcp-http") {
  const dashboardUrl = readOption(args, "--dashboard-url") ?? "http://127.0.0.1:18888";
  const host = readOption(args, "--host") ?? "127.0.0.1";
  const port = numberOption(args, "--port") ?? 18889;
  const { runMcpHttpServer } = await import("@devdash/server/mcp");
  await runMcpHttpServer({ dashboardUrl, host, port });
} else if (command === "open") {
  const baseUrl = readOption(args, "--dashboard-url") ?? "http://127.0.0.1:18888";
  const open = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  await import("node:child_process").then(({ execFile }) => execFile(open, [baseUrl]));
} else {
  console.error(`Unknown command: ${command}`);
  console.error("Usage: devdash serve|clear|export|import|retention|mcp|mcp-http|open");
  process.exit(1);
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
  assign(overrides, "webDistDir", readOption(args, "--web-dist"));
  return readConfig(overrides);
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
    return args[index + 1];
  }
  const prefix = `${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function numberOption(args: string[], name: string): number | undefined {
  const value = readOption(args, name);
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
