import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerConfig } from "./config.js";
import { registerApiRoutes } from "./api/routes.js";
import { startOtlpGrpcReceiver } from "./otlp/grpcReceiver.js";
import { registerOtlpRoutes } from "./otlp/httpReceiver.js";
import { MemoryTelemetryStore } from "./store/memoryStore.js";
import { SqliteTelemetryStore } from "./store/sqliteStore.js";
import type { TelemetryStore } from "./store/types.js";

export interface RunningServers {
  dashboard: FastifyInstance;
  otlp: FastifyInstance;
  otlpGrpc: Awaited<ReturnType<typeof startOtlpGrpcReceiver>>;
  store: TelemetryStore;
  close(): Promise<void>;
}

export async function startServers(config: ServerConfig): Promise<RunningServers> {
  const store = createStore(config);

  const dashboard = Fastify({ logger: false, bodyLimit: 20 * 1024 * 1024 });
  const otlp = Fastify({ logger: false, bodyLimit: 20 * 1024 * 1024 });

  await dashboard.register(cors, { origin: true });
  await otlp.register(cors, { origin: true });

  registerApiRoutes(dashboard, store);
  registerOtlpRoutes(otlp, store, {
    maxAgeMs: config.retentionMs,
    maxTraces: config.maxTraces,
    maxLogs: config.maxLogs,
    maxMetrics: config.maxMetrics,
    maxDbSizeBytes: config.maxDbSizeBytes
  });

  const webDistDir = resolveWebDistDir(config.webDistDir);
  if (webDistDir && existsSync(webDistDir)) {
    await dashboard.register(fastifyStatic, {
      root: webDistDir,
      prefix: "/"
    });
    dashboard.setNotFoundHandler((_request, reply) => {
      void reply.sendFile("index.html");
    });
  } else {
    dashboard.get("/", async () => {
      return {
        name: "Local OTLP Workbench",
        message: "Build apps/web or run pnpm dev for the dashboard UI.",
        api: "/api/health"
      };
    });
  }

  await dashboard.listen({ host: config.host, port: config.dashboardPort });
  await otlp.listen({ host: config.host, port: config.otlpHttpPort });
  const otlpGrpc = await startOtlpGrpcReceiver({
    host: config.host,
    port: config.otlpGrpcPort,
    store,
    retention: {
      maxAgeMs: config.retentionMs,
      maxTraces: config.maxTraces,
      maxLogs: config.maxLogs,
      maxMetrics: config.maxMetrics,
      maxDbSizeBytes: config.maxDbSizeBytes
    }
  });

  return {
    dashboard,
    otlp,
    otlpGrpc,
    store,
    close: async () => {
      await Promise.allSettled([dashboard.close(), otlp.close()]);
      otlpGrpc.close();
      store.close?.();
    }
  };
}

function createStore(config: ServerConfig): TelemetryStore {
  if (config.storage === "sqlite") {
    return new SqliteTelemetryStore(path.resolve(config.dbPath), {
      maxMetricAttributeSets: config.maxMetricAttributeSets ?? 1_000
    });
  }

  return new MemoryTelemetryStore({
    maxSpans: config.maxSpans,
    maxLogs: config.maxLogs,
    maxBatches: config.maxBatches,
    maxMetrics: config.maxMetrics,
    maxMetricAttributeSets: config.maxMetricAttributeSets ?? 1_000
  });
}

function resolveWebDistDir(explicit?: string): string | undefined {
  if (explicit) {
    return path.resolve(explicit);
  }

  const currentFile = fileURLToPath(import.meta.url);
  const serverSrcDir = path.dirname(currentFile);
  return path.resolve(serverSrcDir, "../../web/dist");
}
