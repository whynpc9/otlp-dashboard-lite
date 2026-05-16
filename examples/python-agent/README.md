# Python Agent Smoke

Run the dashboard first:

```bash
pnpm serve
```

Then send a trace:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r examples/python-agent/requirements.txt
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
python examples/python-agent/agent_smoke.py
```

The dashboard should show service `python-agent-smoke` with GenAI and RAG metadata.
