# @devdash/otel-proto

This package contains the Buf generation workflow for OpenTelemetry Protocol TypeScript bindings.

```bash
pnpm --filter @devdash/otel-proto generate
```

The current server still uses the lightweight decoder in `apps/server/src/otlp/protobufReader.ts` for the hot ingest path. This package keeps the official OTLP schema generation path available so the decoder can be replaced incrementally without changing the repository layout.

Generated files are committed. The regular repository `pnpm build` only checks that they exist; it does not fetch schemas from the network.
