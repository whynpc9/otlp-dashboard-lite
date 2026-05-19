---
name: local-otel-workbench
description: Use Local OTel Workbench for local OpenTelemetry observability. Start the dashboard, point applications at OTLP, and query logs, traces, spans, and resources with the otel-workbench CLI.
---

# Local OTel Workbench

Use this skill when a project needs local OTLP observability for debugging services, jobs, tests, or AI agents.

## Start the workbench

Install the CLI when it is not available:

```bash
npm i -g local-otel-workbench
```

Start the local dashboard:

```bash
otel-workbench serve
```

Defaults:

- Dashboard UI and query API: `http://127.0.0.1:18888`
- OTLP/gRPC endpoint: `http://127.0.0.1:4317`
- OTLP/HTTP endpoint: `http://127.0.0.1:4318`

Use SQLite persistence when telemetry must survive restarts:

```bash
otel-workbench serve --storage sqlite --db ./.otel/local-otel-workbench.db --retention 7d
```

## Send telemetry

For most OpenTelemetry SDKs:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_SERVICE_NAME=<service-name>
```

For OTLP/gRPC:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4317
export OTEL_EXPORTER_OTLP_PROTOCOL=grpc
export OTEL_SERVICE_NAME=<service-name>
```

Set the service name to the app, worker, test suite, or agent component being debugged.

## Query telemetry

Prefer JSON output when another agent or script will parse the result:

```bash
otel-workbench otel resources --dashboard-url http://127.0.0.1:18888 --format Json
otel-workbench otel logs --dashboard-url http://127.0.0.1:18888 --service <service-name> --limit 50 --format Json
otel-workbench otel traces --dashboard-url http://127.0.0.1:18888 --service <service-name> --has-error --format Json
otel-workbench otel spans --dashboard-url http://127.0.0.1:18888 --trace-id <trace-id> --format Json
```

Useful filters:

- `--from <iso-or-unix-ms>` and `--to <iso-or-unix-ms>` for a time window.
- `--q <text>` for names, IDs, log bodies, or attributes.
- `--severity <text>` for logs.
- `--min-duration-ms <n>` for slow traces or spans.
- `--cursor <nextCursor>` for the next page.

## Rules

- Check whether the workbench is already running before starting another copy.
- After code changes, reproduce the workflow and query logs plus traces again.
- Use `otel-workbench otel spans --trace-id <id> --format Json` to inspect cross-service latency inside a trace.
- Use `otel-workbench clear` only when old telemetry would confuse the current debugging run.
- Do not send secrets or production telemetry to an unauthenticated local dashboard.
