# GenAI OpenTelemetry Framework Support

This document summarizes the example probes under `examples/` for DeepSeek with `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true`.

## Scope

All probes use the same local receiver:

```bash
pnpm serve
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true
```

`DEEPSEEK_API_KEY` can be exported directly or stored in the repository `.env` file. Optional overrides:

```bash
export DEEPSEEK_MODEL=deepseek-chat
export DEEPSEEK_BASE_URL=https://api.deepseek.com
```

For TypeScript AI SDK, the provider package expects `https://api.deepseek.com/v1` by default; the example uses that URL unless `DEEPSEEK_BASE_URL` is set.

## Result Matrix

| Platform | Framework | Example | Native OTel emission | GenAI semantic convention coverage | Content capture behavior | Dashboard support |
| --- | --- | --- | --- | --- | --- | --- |
| .NET | `Microsoft.Extensions.AI` | `examples/dotnet-webapi` | Yes, through `UseOpenTelemetry` | Strong. Emits GenAI semantic convention attributes from `OpenTelemetryChatClient`. | Honors `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true` unless explicitly overridden. | First-class through `gen_ai.*`. |
| Python | LangChain | `examples/python-agent` | Needs instrumentation packages. The example enables LangChain and OpenAI v2 instrumentation. | Mixed. LangChain run spans plus OpenAI-compatible GenAI spans/log events for the underlying DeepSeek request. | OpenAI v2 instrumentation uses the OTel GenAI capture flag, with `true` primarily capturing message content as events/logs unless latest experimental semconv mode is enabled. LangChain instrumentation may also have its own content-control behavior. | First-class for `gen_ai.*`; generic spans and exported logs remain visible in trace detail. |
| TypeScript | AI SDK | `examples/ts-agent` | Yes, when `experimental_telemetry.isEnabled` is set. | Partial. Provider call spans include selected `gen_ai.*` fields, but message content and tool fields are primarily `ai.*`. | AI SDK uses `experimental_telemetry.recordInputs` and `recordOutputs`, not the OTel GenAI capture env var, as its content switch. | The workbench maps AI SDK `ai.*` model, usage, prompt, response, and tool fields into the GenAI view. |

## Live Validation

Validated against DeepSeek on May 19, 2026 with the local receiver on `http://127.0.0.1:14318`.

| Platform | Service | Trace shape | Captured content | Token usage |
| --- | --- | --- | --- | --- |
| .NET | `dotnet-meai-deepseek` | 2 spans, 1 GenAI span | system, user, assistant turns from `gen_ai.input.messages` / `gen_ai.output.messages` | 37 input / 15 output |
| Python | `python-langchain-deepseek` | 3 spans, 2 GenAI spans, 3 GenAI message logs | system, user, assistant turns from indexed `gen_ai.prompt.*` / `gen_ai.completion.*`; duplicate OpenAI v2 message logs are also exported | 68 input / 24 output across the LangChain and OpenAI-compatible spans |
| TypeScript | `ts-ai-sdk-deepseek` | 3 spans, 2 GenAI spans | content appears in `ai.prompt`, `ai.prompt.messages`, and `ai.response.text`; the dashboard maps these into conversation turns | 35 input / 16 output on the provider-call span |

The Python probe pins `wrapt<2` because the current `opentelemetry-instrumentation-langchain` release calls `wrap_function_wrapper` with keyword arguments that are incompatible with `wrapt` 2.x.

## How To Run

.NET:

```bash
dotnet run --project examples/dotnet-webapi/DotnetOtlpSmoke.csproj
```

Python:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r examples/python-agent/requirements.txt
python examples/python-agent/agent_smoke.py
```

TypeScript:

```bash
cd examples/ts-agent
pnpm install
pnpm start
```

## What To Check

Open `http://localhost:18888`, then inspect the GenAI traces view:

- `.NET`: confirm service `dotnet-meai-deepseek`, model `deepseek-chat`, token usage, and captured prompt/response turns.
- `Python`: confirm service `python-langchain-deepseek`, LangChain wrapper span, OpenAI-compatible DeepSeek span, and whether prompt/response content appears as span attributes, span events, or exported logs.
- `TypeScript`: confirm service `ts-ai-sdk-deepseek`, `ai.generateText` and `ai.generateText.doGenerate` spans, token usage from `gen_ai.usage.*` or `ai.usage.*`, and prompt/response turns from `ai.prompt*` and `ai.response*`.

## Source Notes

- OpenTelemetry GenAI semantic conventions currently remain development status, and content capture is opt-in because prompts and outputs can be sensitive.
- `Microsoft.Extensions.AI` documents `UseOpenTelemetry` as following the OpenTelemetry GenAI semantic conventions, and `OpenTelemetryChatClient.EnableSensitiveData` defaults from `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`.
- AI SDK telemetry is experimental. It emits OpenTelemetry spans only when `experimental_telemetry` is enabled and records inputs/outputs by default unless `recordInputs` or `recordOutputs` are disabled.
- Current OpenTelemetry Python contrib documentation lists official OpenAI v2 GenAI instrumentation. The LangChain probe therefore validates LangChain with both LangChain instrumentation and the underlying OpenAI-compatible DeepSeek request instrumentation rather than assuming LangChain alone emits standard `gen_ai.*`.
