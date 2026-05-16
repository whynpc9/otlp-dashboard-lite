# Local OTLP Workbench for Microservices + AI Agents 开发计划

> 本文把项目目标按 **OTLP/OpenTelemetry Protocol** 理解。当前目录名是 `oltp-dashboard-lite`，但产品、代码和文档建议统一使用 `OTLP`，避免和数据库事务场景里的 `OLTP` 混淆。

## 1. 项目定位

目标不是复刻一个完整 APM，也不是直接复刻 Aspire Dashboard，而是做一个面向本地开发、跨语言、可持久化、Agent 友好的轻量 OTLP 调试台：

> 一个 JS/TS 实现的轻量本地 OTLP receiver + 查询 API + 调试 UI + MCP/Agent 接口，优先服务 .NET 微服务与 Python/JS/TS AI Agent 应用开发。

核心差异化：

- **跨语言**：接收任何能发 OTLP 的 .NET / Python / JS / TS 应用数据。
- **本地轻量**：默认 memory store，启动即用，不依赖 Collector、Postgres、ClickHouse、Elasticsearch。
- **可持久化**：SQLite 持久化可选，支持历史复盘、导入导出、重放。
- **Agent-first**：GenAI span classifier、Agent timeline、RAG debug view、MCP tools 是核心能力，不是后期插件。
- **规范兼容**：优先兼容 OTLP/HTTP，随后支持 OTLP/gRPC；保留 raw OTLP，避免早期 schema 锁死。

参考事实：

- Aspire standalone 可接收任何 OpenTelemetry-enabled app 的 telemetry，默认 UI 端口 `18888`、OTLP/gRPC `4317`、OTLP/HTTP `4318`，standalone telemetry 默认保存在内存中，重启后不保留。来源：[Standalone Aspire dashboard](https://aspire.dev/dashboard/standalone/)
- OpenTelemetry exporter 配置支持 `grpc`、`http/protobuf`、`http/json`，OTLP/gRPC 默认 `4317`，OTLP/HTTP 默认 `4318`。来源：[OTLP Exporter Configuration](https://opentelemetry.io/docs/languages/sdk-configuration/otlp-exporter/)
- OTLP/HTTP 的成功、partial success、bad data、retryable 状态码有明确协议要求。来源：[OTLP Specification](https://opentelemetry.io/docs/specs/otlp/)
- Aspire 已经把 dashboard telemetry 暴露给 AI coding agents，说明 “observability data for agents” 是现实需求。来源：[Dashboard and AI coding agents](https://aspire.dev/dashboard/ai-coding-agents/)
- OTel GenAI semantic conventions 已覆盖 Generative AI、Agent、MCP 等方向，但仍要按多版本、多来源做兼容层。来源：[Semantic conventions for generative AI systems](https://opentelemetry.io/docs/specs/semconv/gen-ai/)

## 2. 非目标

首版不做这些能力：

- 不做完整 Grafana/Datadog/Tempo/Jaeger 替代品。
- 不做生产级多租户、权限体系、远程 SaaS 部署。
- 不依赖 OpenTelemetry Collector 作为启动前提。
- 不实现 PromQL 或复杂 metrics query language。
- 不接 profiles 信号；OTLP profiles 仍不应进入 MVP。
- 不默认持久化 prompt/completion 原文。

## 3. 推荐技术栈

| 层 | 首选 | 说明 |
| --- | --- | --- |
| Runtime | Node.js + TypeScript | 统一 CLI、server、UI、MCP、Docker 打包路径。 |
| Monorepo | pnpm workspace + Turborepo 可选 | 初期 pnpm workspace 足够，Turborepo 可后置。 |
| OTLP/HTTP | Fastify | Node 服务端生态稳，body/gzip/content-type 控制清晰。 |
| OTLP/gRPC | `@grpc/grpc-js` 或 ConnectRPC | v1 必备，Phase 4 实现；MVP 先留接口边界。 |
| Protobuf | Buf + `@bufbuild/protobuf` | 从 `opentelemetry-proto` 生成类型，避免手写解析。 |
| Store | Memory ring buffer + SQLite/WAL | 默认低摩擦，SQLite 做本地持久化主库。 |
| 分析扩展 | DuckDB 可选 | 只在历史分析、导出分析、session 聚合需求出现后加入。 |
| API | Fastify REST | UI、CLI、MCP 复用同一查询层。 |
| Web | Vite + React + TanStack Query/Table + uPlot | 重表格、重时间轴、重过滤，避免过早引入复杂图表平台。 |
| MCP | 官方 TypeScript SDK | stdio 默认，Streamable HTTP 可选。 |
| CLI | `tsx`/`node` + `commander` 或 `cac` | 先保证 `npx` 可运行和参数稳定。 |

## 4. 总体架构

```text
.NET / Python / JS / TS apps
        │
        │ OTLP/HTTP 4318
        │ OTLP/gRPC 4317
        ▼
┌──────────────────────────┐
│ OTLP Receiver             │
│ /v1/traces /v1/logs       │
│ /v1/metrics + gRPC Export │
└────────────┬─────────────┘
             ▼
┌──────────────────────────┐
│ Decoder + Normalizer      │
│ protobuf/json/gzip        │
│ resource/scope/span/log   │
└────────────┬─────────────┘
             ▼
┌──────────────────────────┐
│ Correlation Engine        │
│ traceId/spanId/service    │
│ logs ↔ traces ↔ metrics   │
│ GenAI span classifier     │
└────────────┬─────────────┘
             ▼
┌──────────────────────────┐
│ Store                     │
│ memory / sqlite / duckdb  │
│ raw OTLP + query indexes  │
└───────┬───────────┬──────┘
        ▼           ▼
   Web UI       API / CLI / MCP
```

关键架构原则：

- **raw OTLP 必须保留**：每个 batch 先进入 raw layer，再派生 normalized query layer。
- **查询模型独立于接收模型**：UI/API 查询 `spans/logs/metric_points/trace_summaries`，不是直接扫 raw payload。
- **receiver 不绑定 store**：OTLP receiver 只依赖 `TelemetryIngestService`，store 可切换 memory/sqlite。
- **GenAI 逻辑独立成包**：`genai-semconv` 只做分类、字段映射、脱敏、摘要，不侵入基础 trace 模型。
- **MCP 复用 API query service**：避免 MCP 和 UI 查询逻辑分叉。

## 5. 建议目录结构

```text
oltp-dashboard-lite/
  apps/
    server/
      src/
        main.ts
        config.ts
        otlp/
          httpReceiver.ts
          grpcReceiver.ts
          decode.ts
          responses.ts
          contentEncoding.ts
        ingest/
          telemetryIngestService.ts
          traceNormalizer.ts
          logNormalizer.ts
          metricNormalizer.ts
          correlationEngine.ts
        api/
          resources.ts
          traces.ts
          logs.ts
          metrics.ts
          genai.ts
          exportImport.ts
        mcp/
          server.ts
          tools.ts
        store/
          types.ts
          memory/
          sqlite/
        test-fixtures/
    web/
      src/
        app/
        pages/
          TracesPage.tsx
          TraceDetailPage.tsx
          LogsPage.tsx
          MetricsPage.tsx
          GenAiPage.tsx
          SettingsPage.tsx
        components/
          TraceWaterfall.tsx
          SpanDetailPanel.tsx
          LogTable.tsx
          MetricChart.tsx
          FilterBar.tsx
        api/
  packages/
    otel-proto/
      buf.gen.yaml
      generated/
    otel-normalizer/
    genai-semconv/
    cli/
  examples/
    dotnet-webapi/
    python-agent/
    ts-agent/
  docs/
    development-plan.md
```

## 6. 数据模型与存储计划

### 6.1 Store 接口

首版先定义统一 store contract，memory 和 sqlite 都实现它：

```ts
export interface TelemetryStore {
  ingestBatch(batch: NormalizedTelemetryBatch): Promise<IngestResult>;
  listResources(query: ResourceQuery): Promise<ResourceSummary[]>;
  listTraces(query: TraceListQuery): Promise<TraceSummary[]>;
  getTrace(traceId: string, format: "normalized" | "otlp-json"): Promise<TraceDetail | OtlpJson | null>;
  listLogs(query: LogQuery): Promise<LogRecordView[]>;
  listMetrics(query: MetricQuery): Promise<MetricDescriptorView[]>;
  getMetricSeries(query: MetricSeriesQuery): Promise<MetricSeries[]>;
  clear(query?: ClearQuery): Promise<ClearResult>;
}
```

### 6.2 Raw layer

Raw layer 目标是保留原始数据、协议元信息和可重放能力。

```sql
create table otlp_batches (
  id integer primary key autoincrement,
  signal text not null,
  protocol text not null,
  received_at integer not null,
  content_type text,
  content_encoding text,
  body blob not null,
  body_json text,
  resource_service_names text,
  accepted_count integer not null default 0,
  rejected_count integer not null default 0,
  warning_message text
);
```

### 6.3 Query layer

Query layer 目标是支撑 UI/API 高频过滤。

```sql
create table spans (
  trace_id text not null,
  span_id text not null,
  parent_span_id text,
  service_name text,
  name text,
  kind integer,
  start_time_unix_nano text,
  end_time_unix_nano text,
  duration_nano integer,
  status_code integer,
  status_message text,
  resource_json text,
  scope_json text,
  attributes_json text,
  events_json text,
  links_json text,
  batch_id integer,
  primary key (trace_id, span_id)
);

create index idx_spans_service_time on spans(service_name, start_time_unix_nano);
create index idx_spans_trace on spans(trace_id);
create index idx_spans_duration on spans(duration_nano);
create index idx_spans_status on spans(status_code);
```

```sql
create table logs (
  id integer primary key autoincrement,
  trace_id text,
  span_id text,
  service_name text,
  severity_number integer,
  severity_text text,
  time_unix_nano text,
  observed_time_unix_nano text,
  body_text text,
  body_json text,
  resource_json text,
  scope_json text,
  attributes_json text,
  batch_id integer
);

create index idx_logs_service_time on logs(service_name, time_unix_nano);
create index idx_logs_trace on logs(trace_id);
create index idx_logs_severity on logs(severity_number);
```

```sql
create table metric_points (
  id integer primary key autoincrement,
  service_name text,
  meter_name text,
  metric_name text,
  metric_type text,
  temporality integer,
  is_monotonic integer,
  start_time_unix_nano text,
  time_unix_nano text,
  value_real real,
  value_int integer,
  attributes_hash text,
  attributes_json text,
  exemplars_json text,
  batch_id integer
);

create index idx_metric_name_time on metric_points(metric_name, time_unix_nano);
create index idx_metric_service_time on metric_points(service_name, time_unix_nano);
```

### 6.4 Derived layer

Trace list 必须查询 derived layer，不能每次聚合 spans。

```sql
create table trace_summaries (
  trace_id text primary key,
  root_span_id text,
  root_name text,
  start_time_unix_nano text,
  end_time_unix_nano text,
  duration_nano integer,
  service_names text,
  span_count integer,
  error_count integer,
  genai_span_count integer,
  input_tokens integer,
  output_tokens integer,
  estimated_cost_usd real,
  first_error_message text,
  updated_at integer not null
);

create index idx_trace_summaries_start on trace_summaries(start_time_unix_nano);
create index idx_trace_summaries_duration on trace_summaries(duration_nano);
create index idx_trace_summaries_error on trace_summaries(error_count);
```

## 7. HTTP API 设计

### 7.1 OTLP ingest API

MVP：

```http
POST /v1/traces
POST /v1/logs
POST /v1/metrics
```

必须支持：

- `application/x-protobuf`
- `application/json`
- `Content-Encoding: gzip`
- 空 envelope 返回成功
- 成功返回对应 signal 的 Export response
- bad data 返回 `400`
- backpressure/限流返回 `429` 或 `503`
- partial success 返回 `200`，同时包含 rejected count 和 error message

### 7.2 Query API

```http
GET /api/health
GET /api/resources
GET /api/logs?service=&severity=&traceId=&spanId=&q=&from=&to=&limit=&cursor=
GET /api/traces?service=&q=&minDurationMs=&hasError=&from=&to=&limit=&cursor=
GET /api/traces/:traceId
GET /api/traces/:traceId?format=otlp-json
GET /api/spans?traceId=&service=&name=
GET /api/metrics
GET /api/metrics/:name/series?service=&from=&to=&attrs=
GET /api/genai/traces
GET /api/genai/traces/:traceId
POST /api/export
POST /api/import
DELETE /api/data
```

响应约定：

- UI 默认使用 `normalized` 格式。
- 导出和 Agent 工具支持 `otlp-json`。
- 所有 list API 支持 cursor 分页。
- 所有时间过滤统一使用 Unix millis 或 ISO-8601，内部转换为 nano string。
- 大字段默认截断，detail API 再拉完整 JSON。

## 8. UI 设计范围

首屏直接进入工作台，不做 marketing landing page。

### 8.1 全局框架

- 左侧导航：Traces、Logs、Metrics、GenAI、Resources、Settings。
- 顶部全局时间范围、service 过滤、storage 状态、ingest 状态。
- 页面内过滤条件必须可复制为 URL query。
- 数据为空时显示接入命令，而不是泛泛说明。

### 8.2 Traces

列表字段：

- start time
- duration
- root span
- service set
- span count
- error count
- GenAI badge

详情视图：

- waterfall
- span tree
- selected span detail
- attributes/events/links
- correlated logs
- GenAI summary when available

### 8.3 Logs

能力：

- service、severity、traceId、spanId、keyword、time range 过滤
- structured body 和 attributes 展开
- 从 log 跳 trace
- trace detail 里显示关联 logs

### 8.4 Metrics

MVP 后置到 Phase 2。轻量版：

- meter/instrument 列表
- metric name、service、attribute set 过滤
- timeseries chart
- histogram 暂以基础摘要展示，不做复杂分桶分析

### 8.5 GenAI

作为一等页面：

- LLM call list：provider、model、latency、tokens、status、traceId
- Agent timeline：agent step、LLM call、tool call、MCP tool、retrieval、rerank
- Prompt/completion 安全视图：metadata、脱敏内容、session-only 原文
- RAG debug：retrieved docs、rerank、final context 摘要

## 9. GenAI/Agent 增强设计

### 9.1 Span 分类

```ts
type GenAiSpanKind =
  | "llm.chat"
  | "llm.completion"
  | "embedding"
  | "rerank"
  | "retrieval"
  | "tool.call"
  | "mcp.tool"
  | "agent.step"
  | "agent.plan"
  | "unknown";
```

兼容来源：

- OTel GenAI semantic conventions
- OTel MCP semantic conventions
- OpenInference attributes
- OpenLLMetry / Traceloop 风格
- LangChain / LlamaIndex 自定义 attributes
- Semantic Kernel / Microsoft Agent Framework 输出的 OTel attributes

### 9.2 安全策略

默认配置：

```yaml
genai:
  captureContent: false
  storePromptHash: true
  maxContentBytes: 32768
  redact:
    emails: true
    apiKeys: true
    jwt: true
    connectionStrings: true
```

UI 策略：

- 默认只显示 metadata。
- 允许显示脱敏内容。
- 原文仅允许本 session 临时查看，不默认落盘。
- 导出时默认移除 GenAI payload，可显式开启。

### 9.3 Trace 派生摘要

为每条 trace 派生：

```ts
interface GenAiTraceSummary {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
  toolCallCount: number;
  failedToolCallCount: number;
  retrievedDocCount?: number;
  longestStep?: string;
  firstError?: string;
}
```

## 10. MCP 设计

MCP 是 v1 必备，不放到最后作为附加项。当前实现已支持 stdio 和 Streamable HTTP 两种 transport。

建议 tools：

```ts
list_resources()
list_recent_errors({ service?: string, minutes?: number })
list_traces({ service?: string, hasError?: boolean, limit?: number })
get_trace({ traceId: string, format?: "summary" | "detail" | "otlp-json" })
list_logs({ service?: string, traceId?: string, severity?: string, q?: string })
get_genai_conversation({ traceId: string })
summarize_trace({ traceId: string })
find_slow_operations({ service?: string, minutes?: number, limit?: number })
```

MCP 输出原则：

- 默认输出摘要和关键字段，不直接倾倒大 JSON。
- 所有工具都带 dashboard deep link。
- 对 prompt/completion 内容遵守同一套 GenAI redaction policy。
- `summarize_trace` 首版只做规则摘要，不调用外部 LLM。

## 11. CLI 设计

最终用户路径：

```bash
npx @your-scope/devdash serve
```

输出：

```text
Dashboard:      http://localhost:18888
OTLP/gRPC:      http://localhost:4317
OTLP/HTTP:      http://localhost:4318
Storage:        memory
```

命令：

```bash
devdash serve
devdash serve --storage sqlite --db ./.otel/devdash.db --retention 7d --max-db-size 2gb
devdash open
devdash clear
devdash export --format otlp-json --out ./telemetry.json
devdash import ./telemetry.json
devdash mcp --dashboard-url http://localhost:18888
```

## 12. 分阶段实施路线

### Phase 0：项目初始化

目标：建立可持续开发骨架。

交付：

- pnpm workspace
- TypeScript baseline
- lint/test/build scripts
- `apps/server` Fastify skeleton
- `apps/web` Vite React skeleton
- `packages/cli` skeleton
- `packages/otel-proto` proto 生成流程
- README：定位、启动方式、接入示例

验收：

- `pnpm install`
- `pnpm build`
- `pnpm test`
- `pnpm dev` 能启动 server + web

### Phase 1：OTLP/HTTP + Memory + Traces/Logs UI

目标：获得最小可用体验，能替代 Aspire standalone 的一小部分本地调试能力。

交付：

- `POST /v1/traces`
- `POST /v1/logs`
- `application/x-protobuf`
- `application/json`
- gzip decode
- OTLP success/partial/bad-data response helper
- memory ring buffer store
- trace normalizer
- log normalizer
- trace summaries in memory
- trace list
- trace waterfall
- log table
- trace/log 跳转
- .NET、Python、Node 最小接入示例

验收：

- .NET sample 能通过 OTLP/HTTP 发送 traces/logs。
- Python sample 能通过 OTLP/HTTP 发送 traces/logs。
- Node sample 能通过 OTLP/HTTP 发送 traces/logs。
- UI 能看到 trace list、waterfall、关联 logs。
- receiver 对 bad protobuf 返回 `400`。
- gzip payload 被正确解析。

建议任务拆分：

1. 生成 OTLP protobuf TypeScript 类型。
2. 实现 content-type 与 gzip 处理。
3. 实现 traces/logs protobuf decode。
4. 实现 traces/logs JSON decode。
5. 建立 `NormalizedSpan`、`NormalizedLogRecord` 模型。
6. 实现 memory store 和 trace summary 聚合。
7. 实现 query API。
8. 实现 web trace/log 页面。
9. 添加三种语言 sample 和 smoke script。

### Phase 2：SQLite 持久化 + Metrics

目标：形成区别于 Aspire standalone 的关键卖点。

交付：

- SQLite store
- WAL 模式
- raw OTLP batches
- normalized spans/logs/metric_points
- trace_summaries
- migrations
- retention：按时间、数量、DB size
- metrics ingest
- metrics list + chart
- import/export OTLP JSON

验收：

- `devdash serve --storage sqlite --db ./.otel/devdash.db` 重启后数据仍在。
- trace list 查询不扫描 raw payload。
- retention 能清理过期 batch 和派生索引。
- counter/gauge/histogram 至少能入库和基础展示。
- export 后 import 到空库，trace/log 数据可恢复。

建议任务拆分：

1. 引入 SQLite driver 和 migration runner。
2. 实现 schema v1。
3. 实现 SQLite `ingestBatch` 事务。
4. 实现 query API 的 sqlite adapter。
5. 实现 retention worker。
6. 实现 metrics normalizer。
7. 实现 metrics UI。
8. 实现 export/import。

### Phase 3：GenAI/Agent 专区

目标：做出产品特色，而不是传统 traces/logs UI。

交付：

- `packages/genai-semconv`
- GenAI span classifier
- OTel GenAI + OpenInference + 常见框架字段映射
- token/cost summary
- LLM call detail
- Agent timeline
- RAG debug view
- prompt/completion redaction
- GenAI trace list

验收：

- OpenAI/LangChain 或等价示例能被识别为 LLM call。
- tool call 能在 timeline 中展示。
- 默认不落盘 prompt/completion 原文。
- 开启脱敏后，email/API key/JWT/connection string 被替换。
- `GET /api/genai/traces/:traceId` 返回 agent-friendly normalized view。

建议任务拆分：

1. 定义 GenAI normalized model。
2. 实现 attribute mapper。
3. 实现 classifier rule set。
4. 实现 redaction pipeline。
5. 扩展 trace_summaries 的 GenAI 字段。
6. 实现 GenAI API。
7. 实现 GenAI 页面。
8. 添加 Agent/RAG example fixtures。

### Phase 4：OTLP/gRPC + MCP + CLI

目标：进入可长期使用的本地工具阶段。

交付：

- gRPC `TraceService.Export`
- gRPC `LogsService.Export`
- gRPC `MetricsService.Export`
- MCP stdio server
- `devdash serve`
- `devdash open`
- `devdash clear`
- `devdash export/import`
- `devdash mcp`

验收：

- .NET 使用 `OTEL_EXPORTER_OTLP_PROTOCOL=grpc` 能直接发送到 `localhost:4317`。
- MCP client 能调用 list traces/logs/get trace。
- CLI 能通过 `npx` 启动。
- CLI 输出包含 dashboard、OTLP/gRPC、OTLP/HTTP、storage 信息。

建议任务拆分：

1. 选择 `@grpc/grpc-js` 或 ConnectRPC 并验证 export service。
2. 实现三类 signal 的 gRPC receiver。
3. 抽象 server lifecycle 和端口占用处理。
4. 实现 CLI 参数解析。
5. 实现 MCP stdio server。
6. 复用 API query service 实现 MCP tools。
7. 增加 e2e smoke。

### Phase 5：性能、稳定性、打包

目标：达到可发布工具质量。

交付：

- Docker image
- npm package
- DB size limit
- attribute cardinality protection
- ingest backpressure
- UI virtualization
- load test fixtures
- telemetry self-observability
- release checklist

验收：

- 单机接收固定速率 telemetry 时 UI 可用。
- 大量 logs/traces 下表格不明显卡顿。
- 超过 memory/DB 限制时有明确丢弃策略和 UI 提示。
- npm 包 dry-run 通过。
- Docker image 能暴露 `18888/4317/4318`。

## 13. 测试策略

### Unit tests

- protobuf/json decode
- gzip handling
- normalization
- trace summary aggregation
- GenAI classifier
- redaction
- SQLite query builder

### Contract tests

- OTLP/HTTP protobuf traces/logs/metrics fixtures
- OTLP/HTTP json traces/logs/metrics fixtures
- partial success response
- bad data response
- retryable response paths

### Integration tests

- Fastify receiver + memory store
- Fastify receiver + sqlite store
- export/import roundtrip
- CLI serve smoke
- MCP stdio tool calls

### Example smoke tests

- .NET WebAPI -> dashboard
- Python script/agent -> dashboard
- Node/TS app -> dashboard
- GenAI/RAG fixture -> GenAI page

### Frontend tests

- trace list render
- waterfall render
- log filtering
- metric chart render
- GenAI timeline render
- mobile/desktop layout sanity via browser screenshot

## 14. 配置设计

建议配置来源优先级：

1. CLI flags
2. env vars
3. config file
4. defaults

示例：

```yaml
server:
  host: "127.0.0.1"
  dashboardPort: 18888
  otlpHttpPort: 4318
  otlpGrpcPort: 4317

storage:
  type: "memory"
  db: "./.otel/devdash.db"
  retention: "7d"
  maxDbSize: "2gb"
  maxMemorySpans: 50000
  maxMemoryLogs: 100000

genai:
  captureContent: false
  storePromptHash: true
  maxContentBytes: 32768

security:
  allowAnonymous: true
  bindRemote: false
```

## 15. 接入说明目标

README 最少需要覆盖：

### .NET OTLP/HTTP

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_SERVICE_NAME=my-dotnet-service
```

### .NET OTLP/gRPC

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317
export OTEL_EXPORTER_OTLP_PROTOCOL=grpc
export OTEL_SERVICE_NAME=my-dotnet-service
```

### Python / JS / TS

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_SERVICE_NAME=my-agent
```

GenAI semantic convention opt-in 不应写成强依赖，只能作为可选建议，因为不同语言 SDK/instrumentation 支持程度不同。

## 16. 风险与应对

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| OTLP protobuf 解析不完整 | 接入失败 | 以官方 proto 生成类型，fixtures 覆盖 traces/logs/metrics。 |
| Metrics 语义误读 | 展示错误 | Phase 2 只做轻量展示，保留 temporality、monotonic、attributes、exemplars 原始字段。 |
| 大量 telemetry 压垮内存 | UI 卡顿或进程 OOM | memory ring buffer、size limit、backpressure、UI virtualization。 |
| SQLite 写入瓶颈 | ingest 延迟 | WAL、批量事务、索引克制、derived summary 异步刷新可选。 |
| GenAI 字段生态分裂 | 识别率低 | classifier 多来源、多版本映射，允许用户查看原始 attributes。 |
| prompt 泄露 | 本地敏感信息风险 | 默认不捕获原文，脱敏优先，导出默认去 payload。 |
| 和 Aspire 定位重叠 | 产品价值不清 | 强调持久化、Agent timeline、MCP tools、跨语言 debug replay。 |
| 端口冲突 | 启动失败 | CLI 检测端口占用，允许 `--dashboard-port/--otlp-http-port/--otlp-grpc-port`。 |

## 17. 推荐初始 Backlog

第一轮建议只排 Phase 0 + Phase 1：

1. 初始化 pnpm workspace。
2. 建立 server/web/cli/packages 目录。
3. 接入 Buf 生成 OTLP protobuf TS 类型。
4. 实现 Fastify `POST /v1/traces` protobuf decode。
5. 实现 Fastify `POST /v1/logs` protobuf decode。
6. 实现 JSON OTLP decode。
7. 实现 gzip decode。
8. 实现 OTLP response helpers。
9. 定义 normalized span/log model。
10. 实现 memory store。
11. 实现 trace summary 聚合。
12. 实现 `/api/traces`、`/api/traces/:traceId`、`/api/logs`。
13. 实现 Vite React 基础布局。
14. 实现 TracesPage、TraceDetailPage、LogsPage。
15. 增加 .NET/Python/Node smoke examples。
16. 补齐 README 的最小启动和接入说明。

Phase 1 完成后，再决定 SQLite 是直接开 Phase 2，还是先补 OTLP/gRPC。如果目标用户优先是 .NET/Aspire 生态，gRPC 可以提前；如果目标是“历史复盘”差异化，SQLite 应优先。

## 18. 里程碑完成定义

MVP 完成定义：

- 用户能运行 `devdash serve`。
- dashboard 在 `http://localhost:18888` 可访问。
- OTLP/HTTP 在 `http://localhost:4318` 可接收 traces/logs。
- 至少一个 .NET 或 Python 示例能看到 trace waterfall 和 correlated logs。
- memory store 有明确上限和淘汰策略。
- README 中有可复制的接入命令。

v1 完成定义：

- OTLP/HTTP traces/logs/metrics 可用。
- OTLP/gRPC traces/logs/metrics 可用。
- SQLite 持久化可用。
- GenAI page 可识别 LLM/tool/RAG 关键 span。
- MCP stdio tools 可用。
- CLI 可通过 `npx` 启动。
- Docker image 可用。
- 有 fixtures、contract tests、integration tests。

## 19. 当前实现进度

截至当前代码版本，已落地：

- pnpm workspace：`apps/server`、`apps/web`、`packages/cli`。
- Buf generation workflow：`packages/otel-proto` 可生成官方 OTLP JavaScript bindings 与 TypeScript declarations，protobuf ingest hot path 已使用生成类型。
- OTLP/HTTP：`/v1/traces`、`/v1/logs`、`/v1/metrics`，支持 JSON、protobuf、gzip。
- OTLP/gRPC：`TraceService.Export`、`LogsService.Export`、`MetricsService.Export` unary 接收。
- Memory store：spans/logs/metrics/batches ring buffer。
- SQLite store：raw batches、spans、logs、metric_points、trace_summaries，WAL，重启持久化，DB size retention。
- API：resources、traces、trace detail、logs、metrics、metric series、GenAI trace、export/import、retention、clear，支持 cursor/time range。
- UI：Traces、Logs、Metrics、GenAI summary/timeline/conversation/RAG document 视图，长列表使用轻量 virtualization。
- GenAI：多来源 span classifier、token/cost summary、tool/RAG counters、retrieved document extraction、conversation reconstruction、normalized-data redaction。
- Metrics：gauge/sum/histogram/exponential histogram/summary 基础归一化，保留 temporality、monotonicity、exemplars、distribution metadata。
- Metrics protection：metric attribute set cardinality limit。
- Ingest protection：HTTP/gRPC ingest backpressure guard。
- CLI：serve、clear、export、import、retention、open、mcp、mcp-http。
- MCP stdio：resources/errors/traces/logs/GenAI/slow-operation tools。
- MCP Streamable HTTP：`/mcp` endpoint 可供 IDE/plugin 集成。
- Dockerfile：本地构建后暴露 `18888`、`4317`、`4318`。
- Examples：Python Agent、TypeScript Agent、.NET WebAPI runnable smoke app。
- Release：GitHub Actions CI、CLI package metadata、`pnpm release:dry-run` pack workflow。
- 测试：HTTP JSON/protobuf/gzip、gRPC protobuf、SQLite persistence、metrics query、histogram/exemplar metadata、export/import、retention、DB size retention、redaction、pagination/time range、RAG documents、GenAI conversation、metric cardinality。

后续产品化可选项：

- npm scope/package name 确认后执行真实 publish。
- 增加大批量 load fixtures 和 UI 截图回归。
- 增加更完整的成本模型配置。
