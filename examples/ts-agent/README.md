# TypeScript Agent Smoke

Run the dashboard first:

```bash
pnpm serve
```

Then send a trace:

```bash
cd examples/ts-agent
pnpm install
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318/v1/traces
pnpm start
```

The dashboard should show service `ts-agent-smoke` with LLM, MCP tool, and RAG metadata.
