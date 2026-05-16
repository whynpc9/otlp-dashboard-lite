# @devdash/otel-proto

This package contains the Buf generation workflow for OpenTelemetry Protocol JavaScript bindings and TypeScript declarations.

```bash
pnpm --filter @devdash/otel-proto generate
```

The server imports these generated bindings for the protobuf ingest path. Generated files are committed. The regular repository `pnpm build` only checks that they exist; it does not fetch schemas from the network.
