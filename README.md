# Local OTLP Workbench

A lightweight local OTLP/OpenTelemetry dashboard for microservices and AI agents.

This repository currently implements the Phase 1 MVP, the core Phase 2 persistence/metrics path, and the first Phase 3/4 Agent integrations from [docs/development-plan.md](./docs/development-plan.md):

- OTLP/HTTP receiver on `4318`
- `POST /v1/traces`
- `POST /v1/logs`
- JSON and protobuf request decoding
- gzip request support
- in-memory trace/log/metric store
- SQLite persistence with raw batches, spans, logs, metric points, and trace summaries
- count/time retention APIs
- import/export of normalized telemetry
- OTLP/gRPC receiver on `4317`
- GenAI/Agent timeline summaries with default normalized-data redaction
- MCP stdio server for local coding agents
- REST query API
- React dashboard UI
- CLI entrypoint

Full generated OTLP proto bindings, PromQL-style metrics queries, Streamable HTTP MCP, and deeper RAG document inspection remain planned v1 work.

## Start

```bash
pnpm install
pnpm build
pnpm serve
```

The CLI prints:

```text
Dashboard:      http://localhost:18888
OTLP/gRPC:      http://localhost:4317
OTLP/HTTP:      http://localhost:4318
Storage:        memory
```

For frontend development:

```bash
pnpm dev
```

The Vite dev server runs on `http://localhost:5173` and proxies API requests to the dashboard server.

## Send OTLP/HTTP telemetry

### .NET / Python / JS / TS

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_SERVICE_NAME=my-service
```

For OTLP/gRPC:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317
export OTEL_EXPORTER_OTLP_PROTOCOL=grpc
export OTEL_SERVICE_NAME=my-service
```

For SDKs that support JSON export:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
export OTEL_SERVICE_NAME=my-service
```

## Useful commands

```bash
pnpm serve
./examples/otlp-json-smoke.sh
pnpm --filter @devdash/cli start -- clear
pnpm --filter @devdash/cli start -- export --out ./telemetry.json
pnpm --filter @devdash/cli start -- import ./telemetry.json
pnpm --filter @devdash/cli start -- retention --retention 7d --max-logs 100000 --max-metrics 100000
pnpm --filter @devdash/cli start -- mcp --dashboard-url http://127.0.0.1:18888
```

SQLite persistence:

```bash
pnpm --filter @devdash/cli start -- serve --storage sqlite --db ./.otel/devdash.db
```

Docker:

```bash
docker build -t local-otlp-workbench .
docker run --rm -p 18888:18888 -p 4317:4317 -p 4318:4318 local-otlp-workbench
```

SQLite uses Node 22's built-in `node:sqlite` module. Node currently prints an experimental warning for that module; the store is still covered by integration tests and can be swapped later if the runtime API changes.

## API

```http
GET /api/health
GET /api/resources
GET /api/traces
GET /api/traces/:traceId
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

## OTLP receiver

```http
POST http://localhost:4318/v1/traces
POST http://localhost:4318/v1/logs
POST http://localhost:4318/v1/metrics
```

`/v1/metrics` supports lightweight OTLP JSON gauge/sum/histogram/summary point normalization and basic protobuf gauge/sum point normalization.

The gRPC receiver supports unary `TraceService.Export`, `LogsService.Export`, and `MetricsService.Export` and reuses the same protobuf normalizer.

## MCP tools

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

The MCP command uses stdio transport and reads dashboard data through the local HTTP API.
