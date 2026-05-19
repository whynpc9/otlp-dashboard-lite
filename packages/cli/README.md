# Local OTel Workbench

Local OTel Workbench is a lightweight local OpenTelemetry dashboard and CLI for inspecting OTLP traces, spans, logs, metrics, and GenAI agent activity during development.

It is built for developers who want a local, disposable observability workbench without setting up a collector stack, a cloud account, or production monitoring infrastructure.

## Quick Start

Install the CLI globally:

```bash
npm i -g local-otel-workbench
```

Start the local workbench:

```bash
otel-workbench serve
```

The CLI starts:

```text
Dashboard:      http://127.0.0.1:18888
OTLP/gRPC:      http://127.0.0.1:4317
OTLP/HTTP:      http://127.0.0.1:4318
Storage:        memory
```

Point an application at the workbench:

```bash
export OTEL_SERVICE_NAME=my-service
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
```

Then open `http://127.0.0.1:18888` or query from the CLI:

```bash
otel-workbench otel resources --format Json
otel-workbench otel traces --service my-service --format Json
otel-workbench otel logs --service my-service --limit 50 --format Json
```

## Why Use It

- Run a local OTLP/HTTP receiver on `4318`.
- Run a local OTLP/gRPC receiver on `4317`.
- View traces, spans, logs, metrics, and service resources in a local dashboard.
- Query telemetry from the CLI for scripts, tests, and coding agents.
- Inspect GenAI spans, token usage, tool calls, RAG retrievals, and agent timelines.
- Use memory storage for disposable sessions or SQLite for local persistence.
- Run MCP stdio or Streamable HTTP servers for agent integrations.

## Sending Telemetry

For OTLP/HTTP protobuf:

```bash
export OTEL_SERVICE_NAME=my-service
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
```

For OTLP/gRPC:

```bash
export OTEL_SERVICE_NAME=my-service
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4317
export OTEL_EXPORTER_OTLP_PROTOCOL=grpc
```

For SDKs that support OTLP JSON over HTTP:

```bash
export OTEL_SERVICE_NAME=my-service
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
```

Supported receiver paths:

```http
POST /v1/traces
POST /v1/logs
POST /v1/metrics
```

## CLI

Start the dashboard and OTLP receivers:

```bash
otel-workbench serve
```

Use SQLite persistence:

```bash
otel-workbench serve --storage sqlite --db ./.otel/local-otel-workbench.db --retention 7d --max-db-size 2gb
```

Query telemetry:

```bash
otel-workbench otel resources --format Json
otel-workbench otel traces --service my-service --has-error --format Json
otel-workbench otel spans --trace-id <trace-id> --format Json
otel-workbench otel logs --service my-service --severity error --format Json
```

Useful query flags:

```text
--dashboard-url <url>        Dashboard API URL. Default: http://127.0.0.1:18888
--service <name>             Filter by service.name
--trace-id <id>              Filter logs or spans by trace ID
--span-id <id>               Filter logs by span ID
--severity <text>            Filter logs by severity text
--q <text>                   Search names, IDs, bodies, or attributes
--from <iso-or-unix-ms>      Start of time window
--to <iso-or-unix-ms>        End of time window
--limit <n>                  Page size
--cursor <nextCursor>        Continue from a previous page
--format table|Json          Output format
```

Data management:

```bash
otel-workbench clear
otel-workbench export --out ./telemetry.json
otel-workbench import ./telemetry.json
otel-workbench retention --retention 7d --max-logs 100000 --max-metrics 100000
```

### Server configuration

The `serve` command reads configuration from environment variables. Each name is prefixed with `LOCAL_OTEL_WORKBENCH_` (or the shorter alias `DEVDASH_`).

```text
LOCAL_OTEL_WORKBENCH_HOST              Bind address. Default: 127.0.0.1
LOCAL_OTEL_WORKBENCH_DASHBOARD_PORT    Dashboard HTTP port. Default: 18888
LOCAL_OTEL_WORKBENCH_OTLP_HTTP_PORT    OTLP/HTTP receiver port. Default: 4318
LOCAL_OTEL_WORKBENCH_OTLP_GRPC_PORT    OTLP/gRPC receiver port. Default: 4317
LOCAL_OTEL_WORKBENCH_STORAGE           memory | sqlite. Default: memory
LOCAL_OTEL_WORKBENCH_DB                SQLite path. Default: ./.otel/local-otel-workbench.db
LOCAL_OTEL_WORKBENCH_RETENTION         Time-based retention, e.g. 7d, 12h, 30m
LOCAL_OTEL_WORKBENCH_MAX_DB_SIZE       Max SQLite size, e.g. 2gb, 500mb
LOCAL_OTEL_WORKBENCH_MAX_TRACES        Cap on retained traces
LOCAL_OTEL_WORKBENCH_MAX_SPANS         Cap on retained spans. Default: 50000
LOCAL_OTEL_WORKBENCH_MAX_LOGS          Cap on retained logs. Default: 100000
LOCAL_OTEL_WORKBENCH_MAX_METRICS       Cap on retained metric points. Default: 100000
LOCAL_OTEL_WORKBENCH_MAX_BATCHES       Cap on retained ingest batches. Default: 1000
```

For example, to run the dashboard on a non-default port:

```bash
LOCAL_OTEL_WORKBENCH_DASHBOARD_PORT=28888 \
LOCAL_OTEL_WORKBENCH_OTLP_HTTP_PORT=14318 \
LOCAL_OTEL_WORKBENCH_OTLP_GRPC_PORT=14317 \
otel-workbench serve
```

## HTTP API

The dashboard server exposes a local JSON API:

```http
GET /api/health
GET /api/resources
GET /api/traces
GET /api/traces/:traceId
GET /api/spans
GET /api/logs
GET /api/metrics
GET /api/metrics/:name/series
GET /api/genai/traces
GET /api/genai/traces/:traceId
DELETE /api/data
POST /api/export
POST /api/import
POST /api/retention
```

List APIs accept `limit`, `cursor`, `from`, and `to` where relevant. Trace and span lists support `service`, `q`, `hasError`, and `minDurationMs`; span lists also support `traceId`.

## MCP

Run the stdio MCP server:

```bash
otel-workbench mcp --dashboard-url http://127.0.0.1:18888
```

Run the Streamable HTTP MCP server:

```bash
otel-workbench mcp-http --port 18889 --dashboard-url http://127.0.0.1:18888
```

The HTTP MCP endpoint is `http://127.0.0.1:18889/mcp`.

Current MCP tools:

```text
list_resources
list_recent_errors
list_traces
get_trace
list_logs
get_genai_conversation
summarize_trace
find_slow_operations
```

## Agent Skill

The source repository includes a reusable Codex-style skill at [`skills/local-otel-workbench/SKILL.md`](https://github.com/whynpc9/local-otel-workbench/tree/main/skills/local-otel-workbench).

Use it to teach coding agents how to:

- start the local workbench,
- configure an application's OTLP exporter,
- query logs, traces, spans, and resources,
- validate telemetry after a code change.

## Notes

- The npm package is a single package: `local-otel-workbench`.
- SQLite uses Node 22's built-in `node:sqlite` module. Node may print an experimental warning when SQLite storage is used.
- This tool is intended for local development and debugging. Do not expose it as a production observability endpoint without adding appropriate authentication and network controls.

## Acknowledgements

Local OTel Workbench is inspired by the standalone [Aspire Dashboard](https://aspire.dev/dashboard/standalone/) workflow, including the idea of a local dashboard that receives OTLP data and can be queried by coding agents.

## References

- [OpenTelemetry](https://opentelemetry.io/)
- [OpenTelemetry Protocol (OTLP) specification](https://opentelemetry.io/docs/specs/otlp/)
- [OTLP exporter configuration](https://opentelemetry.io/docs/concepts/sdk-configuration/otlp-exporter-configuration/)
- [OpenTelemetry semantic conventions](https://opentelemetry.io/docs/specs/semconv/)
- [OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
- [OpenTelemetry GenAI spans](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/)
- [Aspire standalone dashboard](https://aspire.dev/dashboard/standalone/)
