import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { generateText, stepCountIs, tool } from "ai";
import { config as loadDotEnv } from "dotenv";
import { z } from "zod";

loadNearestDotEnv();

process.env.OTEL_SERVICE_NAME ??= "ts-ai-sdk-deepseek-complex";
process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT ??= "true";

const serviceName = process.env.OTEL_SERVICE_NAME ?? "ts-ai-sdk-deepseek-complex";
const modelName = process.env.DEEPSEEK_MODEL ?? "deepseek-chat";
const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
  throw new Error("DEEPSEEK_API_KEY is required. Put it in .env or export it before running this example.");
}

const provider = new NodeTracerProvider({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    "service.namespace": "local-otel-workbench.examples",
    "deployment.environment.name": "local-e2e"
  }),
  spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: traceEndpoint() }))]
});
provider.register();

const tracer = trace.getTracer("ts-ai-sdk-deepseek-complex");
const deepseek = createDeepSeek({
  apiKey,
  baseURL: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1"
});

type JsonObject = Record<string, unknown>;

const incidentDocs = [
  {
    id: "runbook-checkout-431",
    title: "Checkout 431 header overflow runbook",
    score: 0.94,
    content: "When checkout emits 431, compare cart cookie size, auth token growth, and recent gateway header policy changes."
  },
  {
    id: "trace-pattern-auth-loop",
    title: "Auth token refresh loop trace pattern",
    score: 0.87,
    content: "A refresh loop creates repeated auth.validate spans before checkout.create_order and usually increases p95 latency."
  },
  {
    id: "runbook-vector-rerank",
    title: "RAG rerank latency checklist",
    score: 0.71,
    content: "Vector search and rerank spans should remain under 500ms for local incident assistant workflows."
  }
];

const tools = {
  searchIncidents: tool({
    description: "Search local incident runbooks and trace-pattern notes for a service symptom.",
    inputSchema: z.object({
      service: z.string().describe("Service name, for example checkout-api"),
      symptom: z.string().describe("Observed symptom or incident clue")
    }),
    execute: async (input) => withToolSpan("searchIncidents", input, async (span) => {
      const matches = incidentDocs.filter((doc) => {
        const haystack = `${doc.title} ${doc.content}`.toLowerCase();
        return haystack.includes(input.service.split("-")[0] ?? input.service) || haystack.includes(input.symptom.toLowerCase().split(" ")[0] ?? "");
      }).slice(0, 3);
      const documents = matches.length ? matches : incidentDocs.slice(0, 2);
      await recordRetrievalSpan("searchIncidents", documents);
      span.setAttribute("retrieval.documents.count", documents.length);
      return { service: input.service, documents };
    })
  }),
  getServiceMetrics: tool({
    description: "Read a compact metrics snapshot for a service.",
    inputSchema: z.object({
      service: z.string(),
      windowMinutes: z.number().int().min(1).max(120)
    }),
    execute: async (input) => withToolSpan("getServiceMetrics", input, async (span) => {
      const output = {
        service: input.service,
        windowMinutes: input.windowMinutes,
        requestRatePerMinute: 128,
        p50LatencyMs: 84,
        p95LatencyMs: 1380,
        errorRate: 0.074,
        topStatusCodes: [
          { status: 200, count: 1840 },
          { status: 431, count: 118 },
          { status: 503, count: 23 }
        ]
      };
      span.setAttribute("metrics.error_rate", output.errorRate);
      span.setAttribute("metrics.p95_latency_ms", output.p95LatencyMs);
      return output;
    })
  }),
  inspectTraceSample: tool({
    description: "Inspect a representative distributed trace and return relevant spans.",
    inputSchema: z.object({
      service: z.string(),
      traceHint: z.string().describe("Short hint for selecting a trace sample")
    }),
    execute: async (input) => withToolSpan("inspectTraceSample", input, async (span) => {
      const output = {
        traceId: "e2e0f00d111122223333444455556666",
        service: input.service,
        rootSpan: "POST /checkout",
        durationMs: 1842,
        spans: [
          { name: "gateway.parse_headers", durationMs: 39, status: "ok" },
          { name: "auth.refresh_token", durationMs: 612, status: "ok" },
          { name: "auth.validate_session", durationMs: 384, status: "ok" },
          { name: "checkout.create_order", durationMs: 712, status: "error", error: "HTTP 431 from upstream gateway" }
        ],
        firstError: "checkout.create_order returned HTTP 431 after auth refresh loop"
      };
      span.setAttribute("trace.sample.trace_id", output.traceId);
      span.setAttribute("trace.sample.first_error", output.firstError);
      return output;
    })
  }),
  createRemediationPlan: tool({
    description: "Create a remediation plan from evidence, owner, and risk level.",
    inputSchema: z.object({
      owner: z.string(),
      riskLevel: z.enum(["low", "medium", "high"]),
      evidence: z.array(z.string()).min(1)
    }),
    execute: async (input) => withToolSpan("createRemediationPlan", input, async (span) => {
      const output = {
        owner: input.owner,
        riskLevel: input.riskLevel,
        actions: [
          "Temporarily lower cart cookie payload and rotate oversized session tokens.",
          "Add an alert on gateway 431 rate > 2% for checkout-api.",
          "Patch auth refresh loop and validate with a replayed e2e checkout trace."
        ],
        rollback: "Disable the token refresh optimization flag and restore prior cookie serializer."
      };
      span.setAttribute("remediation.risk_level", input.riskLevel);
      span.setAttribute("remediation.action_count", output.actions.length);
      return output;
    })
  })
};

try {
  const result = await tracer.startActiveSpan("agent.session.deepseek_complex_e2e", {
    attributes: {
      "openinference.span.kind": "agent",
      "agent.name": "checkout-incident-commander",
      "agent.scenario": "multi-step-tool-calling",
      "gen_ai.provider.name": "deepseek",
      "gen_ai.request.model": modelName
    }
  }, async (sessionSpan) => {
    try {
      const triage = await runAgentStep("triage", `
You are an incident commander for local OpenTelemetry validation.
Use tools before finalizing. First search incidents for checkout-api header errors, then inspect metrics, then inspect a trace sample, then create a remediation plan.
Return a concise incident summary with evidence bullets and next actions.
`);

      const validation = await runAgentStep("validation", `
Previous triage summary:
${triage.text}

Now do a second validation round. Use getServiceMetrics and createRemediationPlan again if needed.
Focus on whether the remediation is safe to test in a local replay environment.
`);

      sessionSpan.setAttribute("agent.rounds", 2);
      sessionSpan.setAttribute("agent.triage.steps", triage.steps.length);
      sessionSpan.setAttribute("agent.validation.steps", validation.steps.length);
      sessionSpan.setAttribute("gen_ai.usage.input_tokens", totalUsage(triage, "inputTokens") + totalUsage(validation, "inputTokens"));
      sessionSpan.setAttribute("gen_ai.usage.output_tokens", totalUsage(triage, "outputTokens") + totalUsage(validation, "outputTokens"));

      return { triage, validation };
    } catch (error) {
      markSpanError(sessionSpan, error);
      throw error;
    } finally {
      sessionSpan.end();
    }
  });

  console.log("DeepSeek complex triage:");
  console.log(result.triage.text.trim());
  console.log("\nDeepSeek validation:");
  console.log(result.validation.text.trim());
  console.log("\nsent ts-ai-sdk-deepseek-complex trace");
  console.log(`steps: triage=${result.triage.steps.length}, validation=${result.validation.steps.length}`);
} finally {
  await provider.forceFlush();
  await provider.shutdown();
}

async function runAgentStep(stepName: "triage" | "validation", prompt: string) {
  return tracer.startActiveSpan(`agent.step.${stepName}`, {
    attributes: {
      "openinference.span.kind": "agent",
      "agent.step.name": stepName,
      "gen_ai.provider.name": "deepseek",
      "gen_ai.request.model": modelName
    }
  }, async (span) => {
    try {
      const response = await generateText({
        model: deepseek(modelName),
        system: "You are a careful SRE agent. Use available tools when asked. Keep final answers compact and evidence-based.",
        prompt,
        tools,
        stopWhen: stepCountIs(8),
        maxOutputTokens: 700,
        experimental_telemetry: {
          isEnabled: true,
          functionId: `deepseek-complex-${stepName}`,
          recordInputs: true,
          recordOutputs: true,
          metadata: {
            framework: "ai-sdk",
            provider: "deepseek",
            scenario: "multi-step-tool-calling",
            stepName
          }
        }
      });
      span.setAttribute("agent.step.count", response.steps.length);
      span.setAttribute("agent.response.length", response.text.length);
      return response;
    } catch (error) {
      markSpanError(span, error);
      throw error;
    } finally {
      span.end();
    }
  });
}

async function withToolSpan<T>(toolName: string, input: JsonObject, fn: (span: Span) => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(`tool.${toolName}`, {
    attributes: {
      "openinference.span.kind": "tool",
      "gen_ai.operation.name": "execute_tool",
      "tool.name": toolName,
      "ai.toolCall.name": toolName,
      "ai.toolCall.args": JSON.stringify(input)
    }
  }, async (span) => {
    try {
      const output = await fn(span);
      span.setAttribute("ai.toolCall.result", JSON.stringify(output));
      return output;
    } catch (error) {
      markSpanError(span, error);
      throw error;
    } finally {
      span.end();
    }
  });
}

async function recordRetrievalSpan(toolName: string, documents: typeof incidentDocs): Promise<void> {
  await tracer.startActiveSpan(`rag.retrieval.${toolName}`, {
    attributes: {
      "openinference.span.kind": "retriever",
      "retrieval.query": "checkout-api header errors auth refresh loop",
      "retrieval.documents.count": documents.length,
      ...Object.fromEntries(documents.flatMap((doc, index) => [
        [`retrieval.documents.${index}.id`, doc.id],
        [`retrieval.documents.${index}.title`, doc.title],
        [`retrieval.documents.${index}.score`, doc.score],
        [`retrieval.documents.${index}.content`, doc.content]
      ]))
    }
  }, async (span) => {
    span.end();
  });
}

function totalUsage(result: Awaited<ReturnType<typeof runAgentStep>>, field: "inputTokens" | "outputTokens"): number {
  return result.usage[field] ?? 0;
}

function markSpanError(span: { recordException(error: Error): void; setStatus(status: { code: SpanStatusCode; message?: string }): void }, error: unknown): void {
  const normalized = error instanceof Error ? error : new Error(String(error));
  span.recordException(normalized);
  span.setStatus({ code: SpanStatusCode.ERROR, message: normalized.message });
}

function traceEndpoint(): string {
  const explicit = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  if (explicit) {
    return explicit;
  }
  const base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318";
  return `${base.replace(/\/$/, "")}/v1/traces`;
}

function loadNearestDotEnv(): void {
  let current = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const candidate = join(current, ".env");
    if (existsSync(candidate)) {
      loadDotEnv({ path: candidate });
      return;
    }
    const parent = dirname(current);
    if (parent === current) {
      return;
    }
    current = parent;
  }
}
