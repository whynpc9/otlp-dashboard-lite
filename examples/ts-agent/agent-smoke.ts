import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { generateText } from "ai";
import { config as loadDotEnv } from "dotenv";

loadNearestDotEnv();

process.env.OTEL_SERVICE_NAME ??= "ts-ai-sdk-deepseek";
process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT ??= "true";

const serviceName = process.env.OTEL_SERVICE_NAME;
const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
  throw new Error("DEEPSEEK_API_KEY is required. Put it in .env or export it before running this example.");
}

const provider = new NodeTracerProvider({
  resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
  spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: traceEndpoint() }))]
});
provider.register();

const deepseek = createDeepSeek({
  apiKey,
  baseURL: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1"
});

const tracer = trace.getTracer("ts-ai-sdk-deepseek");

try {
  const result = await tracer.startActiveSpan("ai-sdk.deepseek.validation", async (span) => {
    try {
      const response = await generateText({
        model: deepseek(process.env.DEEPSEEK_MODEL ?? "deepseek-chat"),
        system: "You are validating OpenTelemetry GenAI instrumentation. Answer in one short sentence.",
        prompt: "Say that the TypeScript AI SDK DeepSeek telemetry probe succeeded.",
        maxOutputTokens: 80,
        experimental_telemetry: {
          isEnabled: true,
          functionId: "ts-ai-sdk-deepseek",
          recordInputs: true,
          recordOutputs: true,
          metadata: {
            framework: "ai-sdk",
            provider: "deepseek",
            contentCaptureEnv: process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT
          }
        }
      });

      span.setAttribute("validation.framework", "AI SDK");
      span.setAttribute("validation.provider", "deepseek");
      span.setAttribute("validation.response.length", response.text.length);
      return response;
    } finally {
      span.end();
    }
  });

  console.log("DeepSeek response:", result.text.trim());
  console.log("sent ts-ai-sdk-deepseek trace");
  console.log("expected telemetry: ai.generateText/ai.generateText.doGenerate spans with ai.* plus selected gen_ai.* attributes");
} finally {
  await provider.forceFlush();
  await provider.shutdown();
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
