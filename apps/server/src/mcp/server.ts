import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

export interface McpServerOptions {
  dashboardUrl: string;
}

export async function runMcpServer(options: McpServerOptions) {
  const baseUrl = options.dashboardUrl.replace(/\/$/, "");
  const server = new McpServer({
    name: "local-otlp-workbench",
    version: "0.1.0"
  });

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
    async ({ service, limit }) => {
      const traces = await getJson<{ traces: unknown[] }>(baseUrl, `/api/traces?${query({ service, hasError: "true", limit })}`);
      const logs = await getJson<{ logs: unknown[] }>(baseUrl, `/api/logs?${query({ service, severity: "error", limit })}`);
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

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Local OTLP Workbench MCP server connected to ${baseUrl}`);
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
