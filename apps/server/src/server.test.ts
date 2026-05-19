import { gzipSync } from "node:zlib";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, credentials } from "@grpc/grpc-js";
import { afterEach, describe, expect, it } from "vitest";
import { startServers, type RunningServers } from "./server.js";

let running: RunningServers | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

describe("OTLP HTTP receiver", () => {
  it("ingests JSON traces and logs", async () => {
    running = await startServers({
      host: "127.0.0.1",
      dashboardPort: 0,
      otlpHttpPort: 0,
      otlpGrpcPort: 0,
      storage: "memory",
      dbPath: ":memory:",
      maxBatches: 100,
      maxLogs: 100,
      maxSpans: 100,
      maxMetrics: 100
    });

    const dashboardUrl = addressUrl(running.dashboard);
    const otlpUrl = addressUrl(running.otlp);

    await postJson(`${otlpUrl}/v1/traces`, tracePayload());
    await postJson(`${otlpUrl}/v1/logs`, logPayload());

    const health = await fetchJson<{ spans: number; logs: number; traces: number }>(`${dashboardUrl}/api/health`);
    expect(health).toMatchObject({ spans: 1, logs: 1, traces: 1 });

    const detail = await fetchJson<{ trace: { genAiSpanCount: number; logs: unknown[] } }>(
      `${dashboardUrl}/api/traces/11111111111111111111111111111111`
    );
    expect(detail.trace.genAiSpanCount).toBe(1);
    expect(detail.trace.logs).toHaveLength(1);
  });

  it("ingests gzip JSON payloads", async () => {
    running = await startServers({
      host: "127.0.0.1",
      dashboardPort: 0,
      otlpHttpPort: 0,
      otlpGrpcPort: 0,
      storage: "memory",
      dbPath: ":memory:",
      maxBatches: 100,
      maxLogs: 100,
      maxSpans: 100,
      maxMetrics: 100
    });

    const otlpUrl = addressUrl(running.otlp);
    const response = await fetch(`${otlpUrl}/v1/traces`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-encoding": "gzip"
      },
      body: gzipSync(JSON.stringify(tracePayload()))
    });

    expect(response.status).toBe(200);
    expect(running.store.stats().spans).toBe(1);
  });

  it("ingests protobuf traces", async () => {
    running = await startServers({
      host: "127.0.0.1",
      dashboardPort: 0,
      otlpHttpPort: 0,
      otlpGrpcPort: 0,
      storage: "memory",
      dbPath: ":memory:",
      maxBatches: 100,
      maxLogs: 100,
      maxSpans: 100,
      maxMetrics: 100
    });

    const otlpUrl = addressUrl(running.otlp);
    const response = await fetch(`${otlpUrl}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/x-protobuf" },
      body: buildTraceProto()
    });

    expect(response.status).toBe(200);
    const detail = running.store.getTrace("11111111111111111111111111111111");
    expect(detail?.rootName).toBe("POST /protobuf");
    expect(detail?.serviceNames).toEqual(["protobuf-api"]);
  });

  it("ingests OTLP/gRPC protobuf traces", async () => {
    running = await startServers({
      host: "127.0.0.1",
      dashboardPort: 0,
      otlpHttpPort: 0,
      otlpGrpcPort: 0,
      storage: "memory",
      dbPath: ":memory:",
      maxBatches: 100,
      maxLogs: 100,
      maxSpans: 100,
      maxMetrics: 100
    });

    await grpcUnary(
      `127.0.0.1:${running.otlpGrpc.port}`,
      "/opentelemetry.proto.collector.trace.v1.TraceService/Export",
      buildTraceProto()
    );

    const detail = running.store.getTrace("11111111111111111111111111111111");
    expect(detail?.rootName).toBe("POST /protobuf");
    expect(detail?.serviceNames).toEqual(["protobuf-api"]);
  });

  it("persists traces and logs in SQLite across restarts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "otel-workbench-sqlite-"));
    const dbPath = join(dir, "local-otel-workbench.db");
    try {
      running = await startServers({
        host: "127.0.0.1",
        dashboardPort: 0,
        otlpHttpPort: 0,
        otlpGrpcPort: 0,
        storage: "sqlite",
        dbPath,
        maxBatches: 100,
        maxLogs: 100,
        maxSpans: 100,
        maxMetrics: 100
      });

      await postJson(`${addressUrl(running.otlp)}/v1/traces`, tracePayload());
      await postJson(`${addressUrl(running.otlp)}/v1/logs`, logPayload());
      await running.close();

      running = await startServers({
        host: "127.0.0.1",
        dashboardPort: 0,
        otlpHttpPort: 0,
        otlpGrpcPort: 0,
        storage: "sqlite",
        dbPath,
        maxBatches: 100,
        maxLogs: 100,
        maxSpans: 100,
        maxMetrics: 100
      });

      const trace = running.store.getTrace("11111111111111111111111111111111");
      expect(trace?.rootName).toBe("POST /orders");
      expect(trace?.logs).toHaveLength(1);
      expect(running.store.stats()).toMatchObject({ storage: "sqlite", traces: 1, spans: 1, logs: 1 });
    } finally {
      await running?.close();
      running = undefined;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("enforces SQLite DB size retention by deleting oldest telemetry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "otel-workbench-sqlite-size-"));
    const dbPath = join(dir, "local-otel-workbench.db");
    try {
      running = await startServers({
        host: "127.0.0.1",
        dashboardPort: 0,
        otlpHttpPort: 0,
        otlpGrpcPort: 0,
        storage: "sqlite",
        dbPath,
        maxBatches: 100,
        maxLogs: 100,
        maxSpans: 100,
        maxMetrics: 100
      });

      const dashboardUrl = addressUrl(running.dashboard);
      await postJson(`${addressUrl(running.otlp)}/v1/traces`, tracePayload());
      await postJson(`${addressUrl(running.otlp)}/v1/logs`, logPayload());
      await postJson(`${addressUrl(running.otlp)}/v1/metrics`, metricPayload());

      const before = await fetchJson<{ dbSizeBytes: number; traces: number; logs: number; metrics: number }>(`${dashboardUrl}/api/health`);
      expect(before.dbSizeBytes).toBeGreaterThan(0);
      expect(before.traces + before.logs + before.metrics).toBeGreaterThan(0);

      const retained = await postAndReadJson<{ deleted: number }>(`${dashboardUrl}/api/retention`, { maxDbSizeBytes: 1 });
      expect(retained.deleted).toBeGreaterThan(0);
      const after = await fetchJson<{ traces: number; logs: number; metrics: number }>(`${dashboardUrl}/api/health`);
      expect(after.traces + after.logs + after.metrics).toBe(0);
    } finally {
      await running?.close();
      running = undefined;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ingests and queries JSON metrics", async () => {
    running = await startServers({
      host: "127.0.0.1",
      dashboardPort: 0,
      otlpHttpPort: 0,
      otlpGrpcPort: 0,
      storage: "memory",
      dbPath: ":memory:",
      maxBatches: 100,
      maxLogs: 100,
      maxSpans: 100,
      maxMetrics: 100
    });

    const dashboardUrl = addressUrl(running.dashboard);
    await postJson(`${addressUrl(running.otlp)}/v1/metrics`, metricPayload());

    const health = await fetchJson<{ metrics: number }>(`${dashboardUrl}/api/health`);
    expect(health.metrics).toBe(2);

    const metrics = await fetchJson<{ metrics: Array<{ metricName: string; pointCount: number }> }>(`${dashboardUrl}/api/metrics`);
    expect(metrics.metrics).toContainEqual(expect.objectContaining({ metricName: "http.server.duration", pointCount: 2 }));

    const series = await fetchJson<{ series: Array<{ value: number }> }>(`${dashboardUrl}/api/metrics/http.server.duration/series`);
    expect(series.series.map((point) => point.value)).toEqual([12.5, 18.25]);
  });

  it("keeps histogram distribution and exemplars in metric series", async () => {
    running = await startServers({
      host: "127.0.0.1",
      dashboardPort: 0,
      otlpHttpPort: 0,
      otlpGrpcPort: 0,
      storage: "memory",
      dbPath: ":memory:",
      maxBatches: 100,
      maxLogs: 100,
      maxSpans: 100,
      maxMetrics: 100
    });

    const dashboardUrl = addressUrl(running.dashboard);
    await postJson(`${addressUrl(running.otlp)}/v1/metrics`, histogramMetricPayload());

    const series = await fetchJson<{ series: Array<{ count: number; sum: number; exemplars: unknown[]; distribution: { kind: string; bucketCounts: number[] } }> }>(
      `${dashboardUrl}/api/metrics/http.server.request.duration/series`
    );
    expect(series.series[0]).toMatchObject({
      count: 3,
      sum: 41,
      distribution: { kind: "explicit", bucketCounts: [1, 2, 0] }
    });
    expect(series.series[0]?.exemplars).toHaveLength(1);
  });

  it("drops metric points beyond the attribute cardinality limit", async () => {
    running = await startServers({
      host: "127.0.0.1",
      dashboardPort: 0,
      otlpHttpPort: 0,
      otlpGrpcPort: 0,
      storage: "memory",
      dbPath: ":memory:",
      maxBatches: 100,
      maxLogs: 100,
      maxSpans: 100,
      maxMetrics: 100,
      maxMetricAttributeSets: 1
    });

    const dashboardUrl = addressUrl(running.dashboard);
    await postJson(`${addressUrl(running.otlp)}/v1/metrics`, metricPayload("/orders"));
    await postJson(`${addressUrl(running.otlp)}/v1/metrics`, metricPayload("/checkout"));

    expect(running.store.stats().metrics).toBe(2);
    const series = await fetchJson<{ series: Array<{ attributes: { route: string } }> }>(`${dashboardUrl}/api/metrics/http.server.duration/series`);
    expect(series.series.map((point) => point.attributes.route)).toEqual(["/orders", "/orders"]);
  });

  it("exports, clears, and imports normalized telemetry", async () => {
    running = await startServers({
      host: "127.0.0.1",
      dashboardPort: 0,
      otlpHttpPort: 0,
      otlpGrpcPort: 0,
      storage: "memory",
      dbPath: ":memory:",
      maxBatches: 100,
      maxLogs: 100,
      maxSpans: 100,
      maxMetrics: 100
    });

    const dashboardUrl = addressUrl(running.dashboard);
    await postJson(`${addressUrl(running.otlp)}/v1/traces`, tracePayload());
    await postJson(`${addressUrl(running.otlp)}/v1/logs`, logPayload());
    await postJson(`${addressUrl(running.otlp)}/v1/metrics`, metricPayload());

    const exported = await postAndReadJson<unknown>(`${dashboardUrl}/api/export`, undefined);
    const clearResponse = await fetch(`${dashboardUrl}/api/data`, { method: "DELETE" });
    expect(clearResponse.status).toBe(200);
    expect(running.store.stats()).toMatchObject({ traces: 0, spans: 0, logs: 0, metrics: 0 });

    const imported = await postAndReadJson<{ imported: number }>(`${dashboardUrl}/api/import`, exported);
    expect(imported.imported).toBe(4);
    expect(running.store.stats()).toMatchObject({ traces: 1, spans: 1, logs: 1, metrics: 2 });
  });

  it("enforces count-based retention through the API", async () => {
    running = await startServers({
      host: "127.0.0.1",
      dashboardPort: 0,
      otlpHttpPort: 0,
      otlpGrpcPort: 0,
      storage: "memory",
      dbPath: ":memory:",
      maxBatches: 100,
      maxLogs: 100,
      maxSpans: 100,
      maxMetrics: 100
    });

    const dashboardUrl = addressUrl(running.dashboard);
    await postJson(`${addressUrl(running.otlp)}/v1/traces`, tracePayload({
      traceId: "11111111111111111111111111111111",
      spanId: "2222222222222222",
      name: "POST /orders",
      startTimeUnixNano: "1715840000000000000",
      endTimeUnixNano: "1715840000840000000"
    }));
    await postJson(`${addressUrl(running.otlp)}/v1/traces`, tracePayload({
      traceId: "33333333333333333333333333333333",
      spanId: "4444444444444444",
      name: "POST /checkout",
      startTimeUnixNano: "1715840001000000000",
      endTimeUnixNano: "1715840001840000000"
    }));
    await postJson(`${addressUrl(running.otlp)}/v1/logs`, logPayload());
    await postJson(`${addressUrl(running.otlp)}/v1/metrics`, metricPayload());

    const retained = await postAndReadJson<{ deleted: number }>(`${dashboardUrl}/api/retention`, {
      maxTraces: 1,
      maxLogs: 0,
      maxMetrics: 1
    });

    expect(retained.deleted).toBeGreaterThanOrEqual(3);
    expect(running.store.stats()).toMatchObject({ traces: 1, spans: 1, logs: 0, metrics: 1 });
    const traces = await fetchJson<{ traces: Array<{ traceId: string }> }>(`${dashboardUrl}/api/traces`);
    expect(traces.traces.map((trace) => trace.traceId)).toEqual(["33333333333333333333333333333333"]);
  });

  it("redacts GenAI content and common secrets in normalized data", async () => {
    running = await startServers({
      host: "127.0.0.1",
      dashboardPort: 0,
      otlpHttpPort: 0,
      otlpGrpcPort: 0,
      storage: "memory",
      dbPath: ":memory:",
      maxBatches: 100,
      maxLogs: 100,
      maxSpans: 100,
      maxMetrics: 100
    });

    const dashboardUrl = addressUrl(running.dashboard);
    await postJson(`${addressUrl(running.otlp)}/v1/traces`, tracePayload({
      extraAttributes: [
        { key: "gen_ai.prompt.0.content", value: { stringValue: "email alice@example.com and use sk-test-secret-secret" } },
        { key: "db.connection_string", value: { stringValue: "postgres://user:pass@localhost:5432/app" } }
      ]
    }));
    await postJson(`${addressUrl(running.otlp)}/v1/logs`, logPayload({
      body: "send to alice@example.com with jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature"
    }));

    const detail = await fetchJson<{ trace: { spans: Array<{ attributes: Record<string, unknown> }>; logs: Array<{ bodyText: string }> } }>(
      `${dashboardUrl}/api/traces/11111111111111111111111111111111`
    );
    const promptText = detail.trace.spans[0]?.attributes["gen_ai.prompt.0.content"];
    expect(promptText).toBe("email [redacted] and use [redacted]");
    expect(detail.trace.spans[0]?.attributes["db.connection_string"]).toBe("[redacted]");
    expect(detail.trace.logs[0]?.bodyText).toContain("[redacted]");
  });

  it("extracts RAG documents from retrieval span attributes", async () => {
    running = await startServers({
      host: "127.0.0.1",
      dashboardPort: 0,
      otlpHttpPort: 0,
      otlpGrpcPort: 0,
      storage: "memory",
      dbPath: ":memory:",
      maxBatches: 100,
      maxLogs: 100,
      maxSpans: 100,
      maxMetrics: 100
    });

    const dashboardUrl = addressUrl(running.dashboard);
    await postJson(`${addressUrl(running.otlp)}/v1/traces`, tracePayload({
      name: "vector retrieval",
      extraAttributes: [
        { key: "retrieval.documents.0.id", value: { stringValue: "doc-1" } },
        { key: "retrieval.documents.0.title", value: { stringValue: "Refund policy" } },
        { key: "retrieval.documents.0.score", value: { doubleValue: 0.93 } },
        { key: "retrieval.documents.0.content", value: { stringValue: "Refunds are available within thirty days for unused orders." } }
      ]
    }));

    const detail = await fetchJson<{ trace: { genAi: { rag: { retrievedDocCount: number; documents: Array<{ title: string; score: number; contentPreview: string }> } } } }>(
      `${dashboardUrl}/api/traces/11111111111111111111111111111111`
    );
    expect(detail.trace.genAi.rag.retrievedDocCount).toBe(1);
    expect(detail.trace.genAi.rag.documents[0]).toMatchObject({
      title: "Refund policy",
      score: 0.93,
      contentPreview: "Refunds are available within thirty days for unused orders."
    });
  });

  it("captures tool call input and output as distinct conversation turns", async () => {
    running = await startServers({
      host: "127.0.0.1",
      dashboardPort: 0,
      otlpHttpPort: 0,
      otlpGrpcPort: 0,
      storage: "memory",
      dbPath: ":memory:",
      maxBatches: 100,
      maxLogs: 100,
      maxSpans: 100,
      maxMetrics: 100
    });

    const dashboardUrl = addressUrl(running.dashboard);
    await postJson(`${addressUrl(running.otlp)}/v1/traces`, tracePayload({
      name: "search_orders tool",
      extraAttributes: [
        { key: "tool.name", value: { stringValue: "search_orders" } },
        { key: "tool.input", value: { stringValue: "{\"query\":\"recent failed orders\"}" } },
        { key: "tool.output", value: { stringValue: "[{\"id\":\"ord_42\",\"status\":\"failed\"}]" } }
      ]
    }));

    const detail = await fetchJson<{ trace: { genAi: { conversation: Array<{ role: string; kind: string; name?: string; contentPreview: string }> } } }>(
      `${dashboardUrl}/api/traces/11111111111111111111111111111111`
    );
    const toolTurns = detail.trace.genAi.conversation.filter((turn) => turn.role === "tool");
    expect(toolTurns.map((turn) => turn.kind)).toEqual(["tool-call", "tool-result"]);
    expect(toolTurns[0]).toMatchObject({ name: "search_orders", contentPreview: "{\"query\":\"recent failed orders\"}" });
    expect(toolTurns[1]).toMatchObject({ name: "search_orders", contentPreview: "[{\"id\":\"ord_42\",\"status\":\"failed\"}]" });
  });

  it("extracts conversation turns from newer GenAI semconv (gen_ai.input.messages array)", async () => {
    running = await startServers({
      host: "127.0.0.1",
      dashboardPort: 0,
      otlpHttpPort: 0,
      otlpGrpcPort: 0,
      storage: "memory",
      dbPath: ":memory:",
      maxBatches: 100,
      maxLogs: 100,
      maxSpans: 100,
      maxMetrics: 100
    });

    const dashboardUrl = addressUrl(running.dashboard);
    const inputMessages = [
      {
        role: "system",
        parts: [{ type: "text", content: "You are a clinical scribe." }]
      },
      {
        role: "user",
        parts: [{ type: "text", content: "术前诊断: 复杂垂体瘤。" }]
      }
    ];
    const outputMessages = [
      {
        role: "assistant",
        parts: [
          { type: "text", content: "Calling diagnosis lookup." },
          { type: "tool_call", id: "call_1", name: "lookup_diagnosis", arguments: { icd: "D35.2" } }
        ],
        finish_reason: "tool_calls"
      }
    ];

    await postJson(`${addressUrl(running.otlp)}/v1/traces`, tracePayload({
      name: "chat Qwen/Qwen3-32B",
      extraAttributes: [
        { key: "gen_ai.operation.name", value: { stringValue: "chat" } },
        { key: "gen_ai.input.messages", value: { stringValue: JSON.stringify(inputMessages) } },
        { key: "gen_ai.output.messages", value: { stringValue: JSON.stringify(outputMessages) } }
      ]
    }));

    const detail = await fetchJson<{ trace: { genAi: { conversation: Array<{ role: string; kind: string; name?: string; contentPreview: string }> } } }>(
      `${dashboardUrl}/api/traces/11111111111111111111111111111111`
    );
    const conv = detail.trace.genAi.conversation;
    expect(conv.map((t) => `${t.role}:${t.kind}`)).toEqual([
      "system:message",
      "user:message",
      "assistant:message",
      "tool:tool-call"
    ]);
    expect(conv[0]?.contentPreview).toBe("You are a clinical scribe.");
    expect(conv[1]?.contentPreview).toBe("术前诊断: 复杂垂体瘤。");
    expect(conv[2]?.contentPreview).toBe("Calling diagnosis lookup.");
    expect(conv[3]).toMatchObject({ name: "lookup_diagnosis" });
    expect(conv[3]?.contentPreview).toContain("D35.2");
  });

  it("extracts conversation turns from OTel GenAI span events", async () => {
    running = await startServers({
      host: "127.0.0.1",
      dashboardPort: 0,
      otlpHttpPort: 0,
      otlpGrpcPort: 0,
      storage: "memory",
      dbPath: ":memory:",
      maxBatches: 100,
      maxLogs: 100,
      maxSpans: 100,
      maxMetrics: 100
    });

    const dashboardUrl = addressUrl(running.dashboard);
    await postJson(`${addressUrl(running.otlp)}/v1/traces`, {
      resourceSpans: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "chat-api" } }] },
          scopeSpans: [
            {
              scope: { name: "openai" },
              spans: [
                {
                  traceId: "11111111111111111111111111111111",
                  spanId: "2222222222222222",
                  name: "chat gpt-4.1",
                  kind: 3,
                  startTimeUnixNano: "1715840000000000000",
                  endTimeUnixNano: "1715840000840000000",
                  attributes: [
                    { key: "gen_ai.system", value: { stringValue: "openai" } },
                    { key: "gen_ai.request.model", value: { stringValue: "gpt-4.1" } }
                  ],
                  events: [
                    {
                      timeUnixNano: "1715840000100000000",
                      name: "gen_ai.system.message",
                      attributes: [
                        { key: "gen_ai.system", value: { stringValue: "openai" } },
                        { key: "content", value: { stringValue: "You are a clinical scribe." } }
                      ]
                    },
                    {
                      timeUnixNano: "1715840000200000000",
                      name: "gen_ai.user.message",
                      attributes: [
                        { key: "gen_ai.system", value: { stringValue: "openai" } },
                        {
                          key: "content",
                          value: {
                            arrayValue: {
                              values: [
                                {
                                  kvlistValue: {
                                    values: [
                                      { key: "type", value: { stringValue: "text" } },
                                      { key: "text", value: { stringValue: "术前诊断: 复杂垂体瘤。" } }
                                    ]
                                  }
                                }
                              ]
                            }
                          }
                        }
                      ]
                    },
                    {
                      timeUnixNano: "1715840000700000000",
                      name: "gen_ai.choice",
                      attributes: [
                        { key: "index", value: { intValue: "0" } },
                        { key: "finish_reason", value: { stringValue: "tool_calls" } },
                        {
                          key: "message",
                          value: {
                            stringValue: JSON.stringify({
                              role: "assistant",
                              content: "Calling search tool.",
                              tool_calls: [
                                {
                                  id: "call_1",
                                  type: "function",
                                  function: { name: "lookup_diagnosis", arguments: "{\"icd\":\"D35.2\"}" }
                                }
                              ]
                            })
                          }
                        }
                      ]
                    }
                  ],
                  status: { code: 1 }
                }
              ]
            }
          ]
        }
      ]
    });

    const detail = await fetchJson<{ trace: { genAi: { conversation: Array<{ role: string; kind: string; name?: string; contentPreview: string }> } } }>(
      `${dashboardUrl}/api/traces/11111111111111111111111111111111`
    );
    const conv = detail.trace.genAi.conversation;
    expect(conv.map((t) => `${t.role}:${t.kind}`)).toEqual([
      "system:message",
      "user:message",
      "assistant:message",
      "tool:tool-call"
    ]);
    expect(conv[0]?.contentPreview).toBe("You are a clinical scribe.");
    expect(conv[1]?.contentPreview).toContain("术前诊断: 复杂垂体瘤。");
    expect(conv[2]?.contentPreview).toBe("Calling search tool.");
    expect(conv[3]).toMatchObject({ name: "lookup_diagnosis", contentPreview: "{\"icd\":\"D35.2\"}" });
  });

  it("reconstructs GenAI conversation turns", async () => {
    running = await startServers({
      host: "127.0.0.1",
      dashboardPort: 0,
      otlpHttpPort: 0,
      otlpGrpcPort: 0,
      storage: "memory",
      dbPath: ":memory:",
      maxBatches: 100,
      maxLogs: 100,
      maxSpans: 100,
      maxMetrics: 100
    });

    const dashboardUrl = addressUrl(running.dashboard);
    await postJson(`${addressUrl(running.otlp)}/v1/traces`, tracePayload({
      extraAttributes: [
        { key: "gen_ai.prompt", value: { stringValue: "What changed in the checkout service?" } },
        { key: "gen_ai.completion", value: { stringValue: "The checkout service emitted correlated traces and logs." } },
        { key: "tool.name", value: { stringValue: "list_recent_errors" } },
        { key: "tool.output", value: { stringValue: "No recent errors." } }
      ]
    }));

    const detail = await fetchJson<{ trace: { genAi: { conversation: Array<{ role: string; contentPreview: string }> } } }>(
      `${dashboardUrl}/api/traces/11111111111111111111111111111111`
    );
    expect(detail.trace.genAi.conversation.map((turn) => turn.role)).toEqual(["user", "assistant", "tool"]);
    expect(detail.trace.genAi.conversation[0]?.contentPreview).toBe("What changed in the checkout service?");
    expect(detail.trace.genAi.conversation[1]?.contentPreview).toBe("The checkout service emitted correlated traces and logs.");
  });

  it("paginates and filters traces, logs, and metric series by time range", async () => {
    running = await startServers({
      host: "127.0.0.1",
      dashboardPort: 0,
      otlpHttpPort: 0,
      otlpGrpcPort: 0,
      storage: "memory",
      dbPath: ":memory:",
      maxBatches: 100,
      maxLogs: 100,
      maxSpans: 100,
      maxMetrics: 100
    });

    const dashboardUrl = addressUrl(running.dashboard);
    await postJson(`${addressUrl(running.otlp)}/v1/traces`, tracePayload({
      traceId: "11111111111111111111111111111111",
      spanId: "2222222222222222",
      name: "old trace",
      startTimeUnixNano: "1715840000000000000",
      endTimeUnixNano: "1715840000840000000"
    }));
    await postJson(`${addressUrl(running.otlp)}/v1/traces`, tracePayload({
      traceId: "33333333333333333333333333333333",
      spanId: "4444444444444444",
      name: "new trace",
      startTimeUnixNano: "1715840001000000000",
      endTimeUnixNano: "1715840001840000000"
    }));
    await postJson(`${addressUrl(running.otlp)}/v1/logs`, logPayload());
    await postJson(`${addressUrl(running.otlp)}/v1/metrics`, metricPayload());

    const firstPage = await fetchJson<{ traces: Array<{ traceId: string }>; nextCursor?: string }>(`${dashboardUrl}/api/traces?limit=1`);
    expect(firstPage.traces.map((trace) => trace.traceId)).toEqual(["33333333333333333333333333333333"]);
    expect(firstPage.nextCursor).toBe("1");

    const secondPage = await fetchJson<{ traces: Array<{ traceId: string }>; nextCursor?: string }>(`${dashboardUrl}/api/traces?limit=1&cursor=${firstPage.nextCursor}`);
    expect(secondPage.traces.map((trace) => trace.traceId)).toEqual(["11111111111111111111111111111111"]);
    expect(secondPage.nextCursor).toBeUndefined();

    const filteredTraces = await fetchJson<{ traces: Array<{ traceId: string }> }>(`${dashboardUrl}/api/traces?from=1715840000900`);
    expect(filteredTraces.traces.map((trace) => trace.traceId)).toEqual(["33333333333333333333333333333333"]);

    const filteredLogs = await fetchJson<{ logs: unknown[] }>(`${dashboardUrl}/api/logs?from=1715840000500`);
    expect(filteredLogs.logs).toHaveLength(0);

    const metricSeries = await fetchJson<{ series: Array<{ value: number }>; nextCursor?: string }>(
      `${dashboardUrl}/api/metrics/http.server.duration/series?from=1715840000550&limit=1`
    );
    expect(metricSeries.series.map((point) => point.value)).toEqual([18.25]);
    expect(metricSeries.nextCursor).toBeUndefined();
  });

  it("filters GenAI traces by time window and service", async () => {
    running = await startServers({
      host: "127.0.0.1",
      dashboardPort: 0,
      otlpHttpPort: 0,
      otlpGrpcPort: 0,
      storage: "memory",
      dbPath: ":memory:",
      maxBatches: 100,
      maxLogs: 100,
      maxSpans: 100,
      maxMetrics: 100
    });

    const dashboardUrl = addressUrl(running.dashboard);
    await postJson(`${addressUrl(running.otlp)}/v1/traces`, tracePayload({
      traceId: "11111111111111111111111111111111",
      spanId: "2222222222222222",
      name: "old genai trace",
      startTimeUnixNano: "1715840000000000000",
      endTimeUnixNano: "1715840000840000000"
    }));
    await postJson(`${addressUrl(running.otlp)}/v1/traces`, tracePayload({
      traceId: "33333333333333333333333333333333",
      spanId: "4444444444444444",
      name: "recent genai trace",
      startTimeUnixNano: "1715840002000000000",
      endTimeUnixNano: "1715840002840000000"
    }));

    const all = await fetchJson<{ traces: Array<{ traceId: string }> }>(`${dashboardUrl}/api/genai/traces`);
    expect(all.traces.map((trace) => trace.traceId).sort()).toEqual([
      "11111111111111111111111111111111",
      "33333333333333333333333333333333"
    ]);

    const filtered = await fetchJson<{ traces: Array<{ traceId: string }> }>(`${dashboardUrl}/api/genai/traces?from=1715840001500`);
    expect(filtered.traces.map((trace) => trace.traceId)).toEqual(["33333333333333333333333333333333"]);

    const byService = await fetchJson<{ traces: Array<{ traceId: string }> }>(`${dashboardUrl}/api/genai/traces?service=checkout-api&limit=1`);
    expect(byService.traces).toHaveLength(1);

    const byOther = await fetchJson<{ traces: Array<{ traceId: string }> }>(`${dashboardUrl}/api/genai/traces?service=nonexistent`);
    expect(byOther.traces).toHaveLength(0);
  });
});

function addressUrl(app: RunningServers["dashboard"]) {
  const address = app.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP server address");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function postJson(url: string, payload: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  expect(response.status).toBe(200);
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  expect(response.status).toBe(200);
  return response.json() as Promise<T>;
}

async function postAndReadJson<T>(url: string, payload: unknown): Promise<T> {
  const init: RequestInit = { method: "POST" };
  if (payload !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(payload);
  }
  const response = await fetch(url, init);
  expect(response.status).toBe(200);
  return response.json() as Promise<T>;
}

async function grpcUnary(address: string, method: string, body: Uint8Array) {
  const client = new Client(address, credentials.createInsecure());
  await new Promise<void>((resolve, reject) => {
    client.makeUnaryRequest(
      method,
      (input: Uint8Array) => Buffer.from(input),
      (output: Buffer) => output,
      body,
      (error) => {
        client.close();
        if (error) {
          reject(error);
          return;
        }
        resolve();
      }
    );
  });
}

function tracePayload(overrides: Partial<{
  traceId: string;
  spanId: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  extraAttributes: Array<{ key: string; value: Record<string, unknown> }>;
}> = {}) {
  const span = {
    traceId: "11111111111111111111111111111111",
    spanId: "2222222222222222",
    name: "POST /orders",
    startTimeUnixNano: "1715840000000000000",
    endTimeUnixNano: "1715840000840000000",
    ...overrides
  };

  return {
    resourceSpans: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: "checkout-api" } }]
        },
        scopeSpans: [
          {
            scope: { name: "demo" },
            spans: [
              {
                traceId: span.traceId,
                spanId: span.spanId,
                name: span.name,
                kind: 2,
                startTimeUnixNano: span.startTimeUnixNano,
                endTimeUnixNano: span.endTimeUnixNano,
                attributes: [
                  { key: "gen_ai.system", value: { stringValue: "openai" } },
                  { key: "gen_ai.request.model", value: { stringValue: "gpt-4.1" } },
                  ...(span.extraAttributes ?? [])
                ],
                status: { code: 1 }
              }
            ]
          }
        ]
      }
    ]
  };
}

function logPayload(overrides: Partial<{ body: string }> = {}) {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: "checkout-api" } }]
        },
        scopeLogs: [
          {
            scope: { name: "demo" },
            logRecords: [
              {
                timeUnixNano: "1715840000420000000",
                severityText: "INFO",
                body: { stringValue: overrides.body ?? "created order draft" },
                traceId: "11111111111111111111111111111111",
                spanId: "2222222222222222"
              }
            ]
          }
        ]
      }
    ]
  };
}

function metricPayload(route = "/orders") {
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: "checkout-api" } }]
        },
        scopeMetrics: [
          {
            scope: { name: "demo-meter" },
            metrics: [
              {
                name: "http.server.duration",
                description: "HTTP server duration",
                unit: "ms",
                gauge: {
                  dataPoints: [
                    {
                      timeUnixNano: "1715840000500000000",
                      asDouble: 12.5,
                      attributes: [{ key: "route", value: { stringValue: route } }]
                    },
                    {
                      timeUnixNano: "1715840000600000000",
                      asDouble: 18.25,
                      attributes: [{ key: "route", value: { stringValue: route } }]
                    }
                  ]
                }
              }
            ]
          }
        ]
      }
    ]
  };
}

function histogramMetricPayload() {
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: "checkout-api" } }]
        },
        scopeMetrics: [
          {
            scope: { name: "demo-meter" },
            metrics: [
              {
                name: "http.server.request.duration",
                unit: "ms",
                histogram: {
                  aggregationTemporality: 2,
                  dataPoints: [
                    {
                      timeUnixNano: "1715840000700000000",
                      count: "3",
                      sum: 41,
                      min: 8,
                      max: 22,
                      explicitBounds: [10, 20],
                      bucketCounts: ["1", "2", "0"],
                      exemplars: [
                        {
                          timeUnixNano: "1715840000690000000",
                          asDouble: 22,
                          traceId: "11111111111111111111111111111111",
                          spanId: "2222222222222222"
                        }
                      ]
                    }
                  ]
                }
              }
            ]
          }
        ]
      }
    ]
  };
}

function buildTraceProto() {
  const resource = message(
    fieldMessage(1, keyValueString("service.name", "protobuf-api"))
  );
  const scope = message(fieldString(1, "test-scope"));
  const span = message(
    fieldBytes(1, hexToBytes("11111111111111111111111111111111")),
    fieldBytes(2, hexToBytes("2222222222222222")),
    fieldString(5, "POST /protobuf"),
    fieldVarint(6, 2),
    fieldFixed64(7, 1_715_840_000_000_000_000n),
    fieldFixed64(8, 1_715_840_000_420_000_000n),
    fieldMessage(15, message(fieldVarint(3, 1)))
  );
  const scopeSpans = message(fieldMessage(1, scope), fieldMessage(2, span));
  const resourceSpans = message(fieldMessage(1, resource), fieldMessage(2, scopeSpans));
  return message(fieldMessage(1, resourceSpans));
}

function keyValueString(key: string, value: string) {
  return message(fieldString(1, key), fieldMessage(2, message(fieldString(1, value))));
}

function message(...parts: Uint8Array[]) {
  return concat(parts);
}

function fieldString(fieldNumber: number, value: string) {
  return fieldBytes(fieldNumber, new TextEncoder().encode(value));
}

function fieldMessage(fieldNumber: number, value: Uint8Array) {
  return fieldBytes(fieldNumber, value);
}

function fieldBytes(fieldNumber: number, value: Uint8Array) {
  return concat([varint(BigInt((fieldNumber << 3) | 2)), varint(BigInt(value.length)), value]);
}

function fieldVarint(fieldNumber: number, value: number | bigint) {
  return concat([varint(BigInt((fieldNumber << 3) | 0)), varint(BigInt(value))]);
}

function fieldFixed64(fieldNumber: number, value: bigint) {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return concat([varint(BigInt((fieldNumber << 3) | 1)), bytes]);
}

function varint(value: bigint) {
  const bytes: number[] = [];
  let current = value;
  while (current >= 0x80n) {
    bytes.push(Number((current & 0x7fn) | 0x80n));
    current >>= 7n;
  }
  bytes.push(Number(current));
  return new Uint8Array(bytes);
}

function concat(parts: Uint8Array[]) {
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function hexToBytes(hex: string) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
