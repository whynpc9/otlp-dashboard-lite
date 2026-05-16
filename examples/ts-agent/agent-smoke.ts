import { trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";

const provider = new NodeTracerProvider({
  resource: resourceFromAttributes({ "service.name": "ts-agent-smoke" }),
  spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())]
});
provider.register();

const tracer = trace.getTracer("ts-agent-smoke");

tracer.startActiveSpan("llm.chat", (span) => {
  span.setAttribute("gen_ai.system", "openai");
  span.setAttribute("gen_ai.request.model", "gpt-4.1");
  span.setAttribute("gen_ai.usage.input_tokens", 96);
  span.setAttribute("gen_ai.usage.output_tokens", 24);
  span.end();
});

tracer.startActiveSpan("mcp.tool search_docs", (span) => {
  span.setAttribute("mcp.tool.name", "search_docs");
  span.setAttribute("retrieval.documents.0.title", "TS smoke document");
  span.setAttribute("retrieval.documents.0.score", 0.88);
  span.setAttribute("retrieval.documents.0.content", "TypeScript agents can emit OTLP directly to the workbench.");
  span.end();
});

await provider.forceFlush();
await provider.shutdown();
console.log("sent ts-agent-smoke trace");
