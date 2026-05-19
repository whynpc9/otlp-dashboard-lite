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

Expected result:

- Service name: `ts-ai-sdk-deepseek`
- Spans: `ai.generateText`, `ai.generateText.doGenerate`, plus the wrapper `ai-sdk.deepseek.validation`
- GenAI support: AI SDK emits native OpenTelemetry spans. It records content with `ai.prompt`, `ai.prompt.messages`, and `ai.response.text`; provider-call spans also include selected `gen_ai.*` fields such as model, provider, finish reason, and token usage.
- Capture flag behavior: AI SDK uses its own `experimental_telemetry.recordInputs` and `recordOutputs` switches. This example sets both to `true`; `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true` is recorded as validation metadata but is not the AI SDK content-capture switch.
