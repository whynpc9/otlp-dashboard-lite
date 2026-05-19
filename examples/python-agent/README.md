# Python LangChain DeepSeek GenAI Probe

This example calls DeepSeek through LangChain and exports OpenTelemetry traces to the local workbench.

Run the dashboard first:

```bash
pnpm serve
```

Then send a trace:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r examples/python-agent/requirements.txt
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true
python examples/python-agent/agent_smoke.py
```

The script loads `DEEPSEEK_API_KEY` from the nearest parent `.env` file when it is not already exported.

Expected result:

- Service name: `python-langchain-deepseek`
- Signals: traces and logs/events are exported over OTLP/HTTP
- Spans: `langchain.deepseek.validation`, LangChain execution spans, and OpenAI-compatible client spans for the DeepSeek call
- GenAI support: LangChain itself does not emit the core OTel GenAI semconv in this script without an instrumentation package. The example enables `opentelemetry-instrumentation-langchain` and `opentelemetry-instrumentation-openai-v2` so the LangChain run and underlying OpenAI-compatible DeepSeek request can be compared.
- Capture flag behavior: OpenAI v2 instrumentation honors `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true` for prompt/response capture, primarily as GenAI message events/logs unless latest experimental semconv mode is enabled. The LangChain instrumentation historically also has its own content switch, so raw content behavior should be checked from exported traces and logs.
