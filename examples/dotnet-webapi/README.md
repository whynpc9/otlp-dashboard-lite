# .NET Microsoft.Extensions.AI DeepSeek GenAI Probe

This example calls DeepSeek through `Microsoft.Extensions.AI` and exports OpenTelemetry traces to the local workbench.

Run the dashboard first:

```bash
pnpm serve
```

Then send a trace:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true
dotnet run --project examples/dotnet-webapi/DotnetOtlpSmoke.csproj
```

The script loads `DEEPSEEK_API_KEY` from the nearest parent `.env` file when it is not already exported.

Expected result:

- Service name: `dotnet-meai-deepseek`
- Spans: `Microsoft.Extensions.AI` chat client spans emitted through `UseOpenTelemetry`
- GenAI support: `OpenTelemetryChatClient` follows OpenTelemetry GenAI semantic conventions, including model, provider, token usage, and input/output content when sensitive data capture is enabled.
- Capture flag behavior: `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true` enables raw prompt/response capture unless explicitly overridden in `UseOpenTelemetry`.
