import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import { z } from "zod";

export interface McpServerOptions {
  dashboardUrl: string;
}

export interface McpHttpServerOptions extends McpServerOptions {
  host: string;
  port: number;
}

export async function runMcpServer(options: McpServerOptions) {
  const baseUrl = options.dashboardUrl.replace(/\/$/, "");
  const server = createWorkbenchMcpServer(baseUrl);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Local OTLP Workbench MCP server connected to ${baseUrl}`);
}

export async function runMcpHttpServer(options: McpHttpServerOptions) {
  const baseUrl = options.dashboardUrl.replace(/\/$/, "");
  const sessions = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport }>();

  const httpServer = createServer(async (request, response) => {
    if (!request.url?.startsWith("/mcp")) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    try {
      const sessionId = typeof request.headers["mcp-session-id"] === "string" ? request.headers["mcp-session-id"] : undefined;
      let session = sessionId ? sessions.get(sessionId) : undefined;
      if (sessionId && !session) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "MCP session not found" }));
        return;
      }
      if (!session) {
        const server = createWorkbenchMcpServer(baseUrl);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID()
        });
        transport.onclose = () => {
          if (transport.sessionId) {
            sessions.delete(transport.sessionId);
          }
        };
        await server.connect(transport as never);
        session = { server, transport };
      }
      await session.transport.handleRequest(request, response);
      if (session.transport.sessionId) {
        sessions.set(session.transport.sessionId, session);
      }
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : "MCP HTTP error" }));
    }
  });

  await new Promise<void>((resolve) => httpServer.listen(options.port, options.host, resolve));
  console.error(`Local OTLP Workbench MCP HTTP server listening on http://${options.host}:${options.port}/mcp`);
  console.error(`Dashboard API: ${baseUrl}`);

  const shutdown = async () => {
    httpServer.close();
    await Promise.allSettled([...sessions.values()].map((session) => session.transport.close()));
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

function createWorkbenchMcpServer(baseUrl: string) {
  const server = new McpServer({
    name: "local-otlp-workbench",
    version: "0.1.0"
  });
  registerWorkbenchTools(server, baseUrl);
  return server;
}

function registerWorkbenchTools(server: McpServer, baseUrl: string) {
  server.registerTool(
    "list_resources",
    {
      title: "List telemetry resources",
      description: "List services/resources currently visible in the local OTLP dashboard.",
      inputSchema: z.object({})
    },
    async () => jsonResult(await getJson(baseUrl, "/api/resources"))
  );
  server.registerTool(
    "list_recent_errors",
    {
      title: "List recent errors",
      description: "List recent error traces and error/fatal logs for a service.",
      inputSchema: z.object({
        service: z.string().optional(),
        minutes: z.number().optional().default(30),
        limit: z.number().optional().default(25)
      })
    },
    async ({ service, minutes, limit }) => {
      const from = new Date(Date.now() - minutes * 60_000).toISOString();
      const traces = await getJson<{ traces: unknown[] }>(baseUrl, `/api/traces?${query({ service, hasError: "true", from, limit })}`);
      const logs = await getJson<{ logs: unknown[] }>(baseUrl, `/api/logs?${query({ service, severity: "error", from, limit })}`);
      return jsonResult({ traces: traces.traces, logs: logs.logs });
    }
  );
  server.registerTool(
    "list_traces",
    {
      title: "List traces",
      description: "List trace summaries with optional service, error, keyword, and limit filters.",
      inputSchema: z.object({
        service: z.string().optional(),
        hasError: z.boolean().optional(),
        q: z.string().optional(),
        limit: z.number().optional().default(20)
      })
    },
    async ({ service, hasError, q, limit }) => jsonResult(await getJson(baseUrl, `/api/traces?${query({ service, hasError, q, limit })}`))
  );
  server.registerTool(
    "get_trace",
    {
      title: "Get trace detail",
      description: "Fetch a normalized trace detail including spans, correlated logs, and GenAI summary.",
      inputSchema: z.object({ traceId: z.string() })
    },
    async ({ traceId }) => jsonResult(await getJson(baseUrl, `/api/traces/${encodeURIComponent(traceId)}`))
  );
  server.registerTool(
    "list_logs",
    {
      title: "List logs",
      description: "List structured logs with optional service, traceId, severity, keyword, and limit filters.",
      inputSchema: z.object({
        service: z.string().optional(),
        traceId: z.string().optional(),
        severity: z.string().optional(),
        q: z.string().optional(),
        limit: z.number().optional().default(50)
      })
    },
    async ({ service, traceId, severity, q, limit }) => jsonResult(await getJson(baseUrl, `/api/logs?${query({ service, traceId, severity, q, limit })}`))
  );
  server.registerTool(
    "get_genai_conversation",
    {
      title: "Get GenAI trace view",
      description: "Fetch GenAI spans, token totals, tool calls, and Agent/RAG timeline for a trace.",
      inputSchema: z.object({ traceId: z.string() })
    },
    async ({ traceId }) => jsonResult(await getJson(baseUrl, `/api/genai/traces/${encodeURIComponent(traceId)}`))
  );
  server.registerTool(
    "summarize_trace",
    {
      title: "Summarize trace",
      description: "Return a compact machine-readable summary of a trace for debugging.",
      inputSchema: z.object({ traceId: z.string() })
    },
    async ({ traceId }) => {
      const data = await getJson<{ trace: TraceLike }>(baseUrl, `/api/traces/${encodeURIComponent(traceId)}`);
      const trace = data.trace;
      return jsonResult({
        traceId: trace.traceId,
        rootName: trace.rootName,
        services: trace.serviceNames,
        durationNano: trace.durationNano,
        spanCount: trace.spanCount,
        errorCount: trace.errorCount,
        firstErrorMessage: trace.firstErrorMessage,
        genAi: trace.genAi
      });
    }
  );
  server.registerTool(
    "find_slow_operations",
    {
      title: "Find slow operations",
      description: "List slow trace summaries above a minimum duration in milliseconds.",
      inputSchema: z.object({
        service: z.string().optional(),
        minDurationMs: z.number().optional().default(500),
        limit: z.number().optional().default(20)
      })
    },
    async ({ service, minDurationMs, limit }) => jsonResult(await getJson(baseUrl, `/api/traces?${query({ service, minDurationMs, limit })}`))
  );
}

interface TraceLike {
  traceId: string;
  rootName: string;
  serviceNames: string[];
  durationNano: number;
  spanCount: number;
  errorCount: number;
  firstErrorMessage?: string | undefined;
  genAi: unknown;
}

async function getJson<T>(baseUrl: string, path: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`);
  if (!response.ok) {
    return {
      error: `${response.status} ${response.statusText}`,
      path
    } as T;
  }
  return response.json() as Promise<T>;
}

function jsonResult(data: unknown) {
  const structuredContent = isRecord(data) ? data : { value: data };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent
  };
}

function query(values: Record<string, string | number | boolean | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") {
      params.set(key, String(value));
    }
  }
  return params.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
