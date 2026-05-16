import { Server, ServerCredentials, status, type sendUnaryData, type ServerUnaryCall } from "@grpc/grpc-js";
import { normalizeOtlpBatch } from "../ingest/normalize.js";
import type { RetentionPolicy, TelemetrySignal, TelemetryStore } from "../store/types.js";

const services: Array<{ path: string; signal: TelemetrySignal }> = [
  { path: "/opentelemetry.proto.collector.trace.v1.TraceService/Export", signal: "traces" },
  { path: "/opentelemetry.proto.collector.logs.v1.LogsService/Export", signal: "logs" },
  { path: "/opentelemetry.proto.collector.metrics.v1.MetricsService/Export", signal: "metrics" }
];

export async function startOtlpGrpcReceiver(input: {
  host: string;
  port: number;
  store: TelemetryStore;
  retention: RetentionPolicy;
  maxConcurrentIngest?: number | undefined;
}) {
  const server = new Server();
  let inFlight = 0;
  for (const service of services) {
    server.register(
      service.path,
      (call: ServerUnaryCall<Buffer, Buffer>, callback: sendUnaryData<Buffer>) => {
        inFlight += 1;
        try {
          if (inFlight > (input.maxConcurrentIngest ?? 4)) {
            callback({
              name: "ResourceExhausted",
              message: "OTLP ingest is busy",
              code: status.RESOURCE_EXHAUSTED
            });
            return;
          }
          const batch = normalizeOtlpBatch({
            signal: service.signal,
            protocol: "http/protobuf",
            receivedAt: Date.now(),
            contentType: "application/x-protobuf",
            body: call.request
          });
          input.store.ingest(batch);
          input.store.enforceRetention(input.retention);
          callback(null, Buffer.alloc(0));
        } catch (error) {
          callback({
            name: "InvalidArgument",
            message: error instanceof Error ? error.message : "Invalid OTLP request",
            code: status.INVALID_ARGUMENT
          });
        } finally {
          inFlight -= 1;
        }
      },
      (response) => response,
      (request) => Buffer.from(request),
      "unary"
    );
  }

  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync(`${input.host}:${input.port}`, ServerCredentials.createInsecure(), (error, boundPort) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(boundPort);
    });
  });

  return {
    port,
    close: () => server.forceShutdown()
  };
}
