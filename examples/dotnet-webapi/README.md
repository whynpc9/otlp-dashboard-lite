# .NET WebAPI Smoke

This directory is a runnable ASP.NET Core minimal API that emits OTLP traces, logs, metrics, and GenAI-style span metadata.

Run against OTLP/HTTP:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_SERVICE_NAME=dotnet-webapi-smoke
dotnet run
curl http://localhost:5000/
```

Run against OTLP/gRPC:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317
export OTEL_EXPORTER_OTLP_PROTOCOL=grpc
export OTEL_SERVICE_NAME=dotnet-webapi-smoke
dotnet run
curl http://localhost:5000/
```

If ASP.NET chooses a different launch port, use the URL printed by `dotnet run`.
