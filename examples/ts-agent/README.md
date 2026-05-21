# TypeScript AI SDK DeepSeek GenAI Probe

This example calls DeepSeek through the Vercel AI SDK and exports OpenTelemetry traces to the local workbench.

Run the dashboard first:

```bash
pnpm serve
```

Then send a trace:

```bash
cd examples/ts-agent
pnpm install
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true
pnpm start
```

The script loads `DEEPSEEK_API_KEY` from the nearest parent `.env` file when it is not already exported.

For a richer end-to-end GenAI/Agent validation trace with multi-step tool calling:

```bash
cd examples/ts-agent
pnpm install
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true
pnpm complex
```

The complex probe creates service `ts-ai-sdk-deepseek-complex` and runs two DeepSeek AI SDK `generateText` rounds inside one agent session. It enables AI SDK telemetry and also emits explicit OpenTelemetry spans for tool calls and RAG retrieval so the dashboard can validate:

- Trace waterfall: parent `agent.session.deepseek_complex_e2e`, child `agent.step.triage` / `agent.step.validation`, AI SDK model spans, tool spans, and retrieval spans.
- GenAI view: DeepSeek provider/model metadata, token usage, prompts/responses, and tool call/result turns.
- Agent/RAG view: `searchIncidents`, `getServiceMetrics`, `inspectTraceSample`, `createRemediationPlan`, retrieved documents, and a two-round agent timeline.

Optional environment variables:

```bash
export DEEPSEEK_MODEL=deepseek-chat
export DEEPSEEK_BASE_URL=https://api.deepseek.com/v1
export OTEL_SERVICE_NAME=ts-ai-sdk-deepseek-complex
```

Expected result:

- Service name: `ts-ai-sdk-deepseek`
- Spans: `ai.generateText`, `ai.generateText.doGenerate`, plus the wrapper `ai-sdk.deepseek.validation`
- GenAI support: AI SDK emits native OpenTelemetry spans. It records content with `ai.prompt`, `ai.prompt.messages`, and `ai.response.text`; provider-call spans also include selected `gen_ai.*` fields such as model, provider, finish reason, and token usage.
- Capture flag behavior: AI SDK uses its own `experimental_telemetry.recordInputs` and `recordOutputs` switches. This example sets both to `true`; `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true` is recorded as validation metadata but is not the AI SDK content-capture switch.
