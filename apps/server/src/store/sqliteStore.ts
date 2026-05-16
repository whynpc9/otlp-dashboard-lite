import { DatabaseSync, type StatementSync } from "node:sqlite";
import { dirname } from "node:path";
import { existsSync, mkdirSync, statSync } from "node:fs";
import type {
  IngestBatch,
  IngestResult,
  LogQuery,
  MetricDescriptor,
  MetricQuery,
  MetricSeriesPoint,
  MetricSeriesQuery,
  NormalizedLogRecord,
  NormalizedMetricPoint,
  NormalizedSpan,
  RawOtlpBatch,
  RetentionPolicy,
  TelemetryStore,
  TraceDetail,
  TraceListQuery,
  TraceSummary
} from "./types.js";
import { summarizeGenAi } from "./memoryStore.js";

export class SqliteTelemetryStore implements TelemetryStore {
  private readonly db: DatabaseSync;
  private readonly dbPath: string;
  private readonly maxMetricAttributeSets: number;
  private readonly insertBatchStmt: StatementSync;
  private readonly insertSpanStmt: StatementSync;
  private readonly insertLogStmt: StatementSync;
  private readonly insertMetricStmt: StatementSync;
  private readonly upsertSummaryStmt: StatementSync;

  constructor(dbPath: string, options: { maxMetricAttributeSets?: number } = {}) {
    this.dbPath = dbPath;
    this.maxMetricAttributeSets = options.maxMetricAttributeSets ?? 1_000;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();

    this.insertBatchStmt = this.db.prepare(`
      insert into otlp_batches (
        id, signal, protocol, received_at, content_type, content_encoding,
        body_size, body, body_json, resource_service_names
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        signal=excluded.signal,
        protocol=excluded.protocol,
        received_at=excluded.received_at,
        content_type=excluded.content_type,
        content_encoding=excluded.content_encoding,
        body_size=excluded.body_size,
        body=excluded.body,
        body_json=excluded.body_json,
        resource_service_names=excluded.resource_service_names
    `);
    this.insertSpanStmt = this.db.prepare(`
      insert or replace into spans (
        trace_id, span_id, parent_span_id, service_name, name, kind,
        start_time_unix_nano, end_time_unix_nano, duration_nano,
        status_code, status_message, resource_json, scope_json,
        attributes_json, events_json, links_json, batch_id
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.insertLogStmt = this.db.prepare(`
      insert or replace into logs (
        id, trace_id, span_id, service_name, severity_number, severity_text,
        time_unix_nano, observed_time_unix_nano, body_text, body_json,
        resource_json, scope_json, attributes_json, batch_id
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.insertMetricStmt = this.db.prepare(`
      insert or replace into metric_points (
        id, service_name, meter_name, metric_name, metric_type, description, unit,
        temporality, is_monotonic, start_time_unix_nano, time_unix_nano,
        value_real, count_value, sum_value, min_value, max_value,
        attributes_hash, attributes_json, exemplars_json, batch_id
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.upsertSummaryStmt = this.db.prepare(`
      insert into trace_summaries (
        trace_id, root_span_id, root_name, start_time_unix_nano, end_time_unix_nano,
        duration_nano, service_names, span_count, error_count, genai_span_count,
        input_tokens, output_tokens, first_error_message, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(trace_id) do update set
        root_span_id=excluded.root_span_id,
        root_name=excluded.root_name,
        start_time_unix_nano=excluded.start_time_unix_nano,
        end_time_unix_nano=excluded.end_time_unix_nano,
        duration_nano=excluded.duration_nano,
        service_names=excluded.service_names,
        span_count=excluded.span_count,
        error_count=excluded.error_count,
        genai_span_count=excluded.genai_span_count,
        input_tokens=excluded.input_tokens,
        output_tokens=excluded.output_tokens,
        first_error_message=excluded.first_error_message,
        updated_at=excluded.updated_at
    `);
  }

  ingest(batch: IngestBatch): IngestResult {
    this.db.exec("begin immediate");
    try {
      this.insertBatch(batch.raw);
      for (const span of batch.spans) {
        this.insertSpan(span);
      }
      for (const log of batch.logs) {
        this.insertLog(log);
      }
      let acceptedMetrics = 0;
      for (const metric of batch.metrics) {
        if (this.canInsertMetric(metric)) {
          this.insertMetric(metric);
          acceptedMetrics += 1;
        }
      }

      for (const traceId of new Set(batch.spans.map((span) => span.traceId))) {
        this.refreshTraceSummary(traceId);
      }
      this.db.exec("commit");

      return {
        accepted: batch.spans.length + batch.logs.length + acceptedMetrics,
        rejected: batch.metrics.length - acceptedMetrics,
        warnings: acceptedMetrics === batch.metrics.length ? [] : [`Dropped ${batch.metrics.length - acceptedMetrics} metric points due to attribute cardinality limits.`]
      };
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  listResources() {
    const spanRows = this.db.prepare(`
      select service_name as serviceName, count(*) as spanCount, max(end_time_unix_nano) as lastSeenNano
      from spans
      group by service_name
    `).all() as Array<{ serviceName: string; spanCount: number; lastSeenNano: string | null }>;
    const logRows = this.db.prepare(`
      select service_name as serviceName, count(*) as logCount, max(coalesce(time_unix_nano, observed_time_unix_nano, '0')) as lastSeenNano
      from logs
      group by service_name
    `).all() as Array<{ serviceName: string; logCount: number; lastSeenNano: string | null }>;

    const resources = new Map<string, { serviceName: string; spanCount: number; logCount: number; lastSeen: number }>();
    for (const row of spanRows) {
      resources.set(row.serviceName, {
        serviceName: row.serviceName,
        spanCount: row.spanCount,
        logCount: 0,
        lastSeen: Number(row.lastSeenNano ?? 0) / 1_000_000
      });
    }
    for (const row of logRows) {
      const current = resources.get(row.serviceName) ?? {
        serviceName: row.serviceName,
        spanCount: 0,
        logCount: 0,
        lastSeen: 0
      };
      current.logCount = row.logCount;
      current.lastSeen = Math.max(current.lastSeen, Number(row.lastSeenNano ?? 0) / 1_000_000);
      resources.set(row.serviceName, current);
    }
    const metricRows = this.db.prepare(`
      select service_name as serviceName, max(time_unix_nano) as lastSeenNano
      from metric_points
      group by service_name
    `).all() as Array<{ serviceName: string; lastSeenNano: string | null }>;
    for (const row of metricRows) {
      const current = resources.get(row.serviceName) ?? {
        serviceName: row.serviceName,
        spanCount: 0,
        logCount: 0,
        lastSeen: 0
      };
      current.lastSeen = Math.max(current.lastSeen, Number(row.lastSeenNano ?? 0) / 1_000_000);
      resources.set(row.serviceName, current);
    }

    return [...resources.values()].sort((a, b) => b.lastSeen - a.lastSeen);
  }

  listTraces(query: TraceListQuery): TraceSummary[] {
    const offset = query.offset ?? 0;
    let rows = (this.db.prepare("select * from trace_summaries order by start_time_unix_nano desc limit ?")
      .all(Math.max((offset + query.limit) * 4, query.limit)) as unknown as SummaryRow[]).map(summaryFromRow);

    if (query.service) {
      rows = rows.filter((trace) => trace.serviceNames.includes(query.service!));
    }
    if (query.hasError !== undefined) {
      rows = rows.filter((trace) => (trace.errorCount > 0) === query.hasError);
    }
    if (query.minDurationMs !== undefined) {
      rows = rows.filter((trace) => trace.durationNano >= query.minDurationMs! * 1_000_000);
    }
    if (query.fromUnixNano) {
      rows = rows.filter((trace) => trace.endTimeUnixNano >= query.fromUnixNano!);
    }
    if (query.toUnixNano) {
      rows = rows.filter((trace) => trace.startTimeUnixNano <= query.toUnixNano!);
    }
    if (query.q) {
      const q = query.q.toLowerCase();
      rows = rows.filter((trace) => trace.rootName.toLowerCase().includes(q) || trace.traceId.includes(q));
    }

    return rows.slice(offset, offset + query.limit);
  }

  getTrace(traceId: string): TraceDetail | undefined {
    const summaryRow = this.db.prepare("select * from trace_summaries where trace_id = ?").get(traceId) as SummaryRow | undefined;
    if (!summaryRow) {
      return undefined;
    }
    const spans = (this.db.prepare("select * from spans where trace_id = ? order by start_time_unix_nano")
      .all(traceId) as unknown as SpanRow[]).map(spanFromRow);
    const logs = (this.db.prepare("select * from logs where trace_id = ? order by coalesce(time_unix_nano, observed_time_unix_nano, '0')")
      .all(traceId) as unknown as LogRow[]).map(logFromRow);

    return {
      ...summaryFromRow(summaryRow),
      spans,
      logs,
      genAi: summarizeGenAi(spans)
    };
  }

  listLogs(query: LogQuery): NormalizedLogRecord[] {
    const offset = query.offset ?? 0;
    let rows = (this.db.prepare("select * from logs order by coalesce(time_unix_nano, observed_time_unix_nano, '0') desc limit ?")
      .all(Math.max((offset + query.limit) * 4, query.limit)) as unknown as LogRow[]).map(logFromRow);

    if (query.service) {
      rows = rows.filter((log) => log.serviceName === query.service);
    }
    if (query.traceId) {
      rows = rows.filter((log) => log.traceId === query.traceId);
    }
    if (query.spanId) {
      rows = rows.filter((log) => log.spanId === query.spanId);
    }
    if (query.severity) {
      rows = rows.filter((log) => (log.severityText ?? "").toLowerCase().includes(query.severity!.toLowerCase()));
    }
    if (query.q) {
      const q = query.q.toLowerCase();
      rows = rows.filter((log) => (log.bodyText ?? "").toLowerCase().includes(q) || JSON.stringify(log.attributes).toLowerCase().includes(q));
    }
    if (query.fromUnixNano) {
      rows = rows.filter((log) => (log.timeUnixNano ?? log.observedTimeUnixNano ?? "0") >= query.fromUnixNano!);
    }
    if (query.toUnixNano) {
      rows = rows.filter((log) => (log.timeUnixNano ?? log.observedTimeUnixNano ?? "0") <= query.toUnixNano!);
    }

    return rows.slice(offset, offset + query.limit);
  }

  listMetrics(query: MetricQuery): MetricDescriptor[] {
    const offset = query.offset ?? 0;
    let rows = (this.db.prepare(`
      select
        service_name as serviceName,
        meter_name as meterName,
        metric_name as metricName,
        metric_type as metricType,
        max(description) as description,
        max(unit) as unit,
        count(*) as pointCount,
        max(time_unix_nano) as lastSeenNano,
        count(distinct attributes_hash) as attributeSets
      from metric_points
      group by service_name, meter_name, metric_name, metric_type
      order by lastSeenNano desc
      limit ?
    `).all(Math.max((offset + query.limit) * 4, query.limit)) as unknown as MetricDescriptorRow[]).map(metricDescriptorFromRow);

    if (query.service) {
      rows = rows.filter((metric) => metric.serviceName === query.service);
    }
    if (query.q) {
      const q = query.q.toLowerCase();
      rows = rows.filter((metric) => metric.metricName.toLowerCase().includes(q));
    }
    if (query.fromUnixNano) {
      rows = rows.filter((metric) => String(Math.floor(metric.lastSeen * 1_000_000)) >= query.fromUnixNano!);
    }
    if (query.toUnixNano) {
      rows = rows.filter((metric) => String(Math.floor(metric.lastSeen * 1_000_000)) <= query.toUnixNano!);
    }
    return rows.slice(offset, offset + query.limit);
  }

  getMetricSeries(query: MetricSeriesQuery): MetricSeriesPoint[] {
    const offset = query.offset ?? 0;
    let rows = (this.db.prepare(`
      select * from metric_points
      where metric_name = ?
      order by time_unix_nano desc
      limit ?
    `).all(query.metricName, Math.max((offset + query.limit) * 4, query.limit)) as unknown as MetricPointRow[]).map(metricPointFromRow);

    if (query.service) {
      rows = rows.filter((point) => point.serviceName === query.service);
    }
    if (query.attrs) {
      rows = rows.filter((point) => point.attributesHash === query.attrs);
    }
    if (query.fromUnixNano) {
      rows = rows.filter((point) => point.timeUnixNano >= query.fromUnixNano!);
    }
    if (query.toUnixNano) {
      rows = rows.filter((point) => point.timeUnixNano <= query.toUnixNano!);
    }

    return rows
      .sort((a, b) => a.timeUnixNano.localeCompare(b.timeUnixNano))
      .slice(offset, offset + query.limit)
      .map((point) => ({
        timeUnixNano: point.timeUnixNano,
        value: point.value,
        count: point.count,
        sum: point.sum,
        min: point.min,
        max: point.max,
        attributes: point.attributes
      }));
  }

  listGenAiTraces(): TraceSummary[] {
    return this.listTraces({ limit: 100 }).filter((trace) => trace.genAiSpanCount > 0);
  }

  exportData() {
    return {
      exportedAt: new Date().toISOString(),
      batches: this.db.prepare("select * from otlp_batches order by received_at").all(),
      spans: (this.db.prepare("select * from spans order by start_time_unix_nano").all() as unknown as SpanRow[]).map(spanFromRow),
      logs: (this.db.prepare("select * from logs order by coalesce(time_unix_nano, observed_time_unix_nano, '0')").all() as unknown as LogRow[]).map(logFromRow),
      metrics: (this.db.prepare("select * from metric_points order by time_unix_nano").all() as unknown as MetricPointRow[]).map(metricPointFromRow),
      traces: (this.db.prepare("select * from trace_summaries order by start_time_unix_nano").all() as unknown as SummaryRow[]).map(summaryFromRow)
    };
  }

  importData(data: unknown) {
    const payload = data as Partial<{
      batches: RawOtlpBatch[];
      spans: NormalizedSpan[];
      logs: NormalizedLogRecord[];
      metrics: NormalizedMetricPoint[];
    }>;
    this.db.exec("begin immediate");
    try {
      for (const batch of payload.batches ?? []) this.insertBatch(batch);
      for (const span of payload.spans ?? []) this.insertSpan(span);
      for (const log of payload.logs ?? []) this.insertLog(log);
      for (const metric of payload.metrics ?? []) this.insertMetric(metric);
      for (const traceId of new Set((payload.spans ?? []).map((span) => span.traceId))) {
        this.refreshTraceSummary(traceId);
      }
      this.db.exec("commit");
      return { imported: (payload.spans?.length ?? 0) + (payload.logs?.length ?? 0) + (payload.metrics?.length ?? 0) };
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  enforceRetention(policy: RetentionPolicy) {
    let deleted = 0;
    if (policy.maxAgeMs) {
      const minNano = String(BigInt(Math.floor((Date.now() - policy.maxAgeMs) * 1_000_000)));
      deleted += this.deleteByTime("spans", "end_time_unix_nano", minNano);
      deleted += this.deleteByTime("logs", "coalesce(time_unix_nano, observed_time_unix_nano, '0')", minNano);
      deleted += this.deleteByTime("metric_points", "time_unix_nano", minNano);
      this.deleteEmptyTraceSummaries();
    }
    if (policy.maxLogs !== undefined) {
      deleted += this.deleteOverflow("logs", "coalesce(time_unix_nano, observed_time_unix_nano, '0')", policy.maxLogs);
    }
    if (policy.maxMetrics !== undefined) {
      deleted += this.deleteOverflow("metric_points", "time_unix_nano", policy.maxMetrics);
    }
    if (policy.maxTraces !== undefined) {
      const rows = this.db.prepare("select trace_id from trace_summaries order by start_time_unix_nano desc limit -1 offset ?")
        .all(policy.maxTraces) as unknown as Array<{ trace_id: string }>;
      for (const row of rows) {
        deleted += this.deleteTrace(row.trace_id);
      }
    }
    if (policy.maxDbSizeBytes !== undefined) {
      deleted += this.enforceDbSize(policy.maxDbSizeBytes);
    }
    return { deleted };
  }

  clear() {
    this.db.exec(`
      delete from trace_summaries;
      delete from logs;
      delete from spans;
      delete from metric_points;
      delete from otlp_batches;
    `);
  }

  stats() {
    return {
      batches: count(this.db, "otlp_batches"),
      spans: count(this.db, "spans"),
      logs: count(this.db, "logs"),
      traces: count(this.db, "trace_summaries"),
      metrics: count(this.db, "metric_points"),
      storage: "sqlite",
      dbPath: this.dbPath,
      dbSizeBytes: this.databaseSizeBytes()
    };
  }

  close() {
    this.db.close();
  }

  private migrate() {
    this.db.exec(`
      create table if not exists otlp_batches (
        id text primary key,
        signal text not null,
        protocol text not null,
        received_at integer not null,
        content_type text not null,
        content_encoding text,
        body_size integer not null,
        body blob,
        body_json text,
        resource_service_names text
      );

      create table if not exists spans (
        trace_id text not null,
        span_id text not null,
        parent_span_id text,
        service_name text not null,
        name text not null,
        kind integer,
        start_time_unix_nano text not null,
        end_time_unix_nano text not null,
        duration_nano integer not null,
        status_code integer,
        status_message text,
        resource_json text not null,
        scope_json text not null,
        attributes_json text not null,
        events_json text not null,
        links_json text not null,
        batch_id text not null,
        primary key (trace_id, span_id)
      );
      create index if not exists idx_spans_service_time on spans(service_name, start_time_unix_nano);
      create index if not exists idx_spans_trace on spans(trace_id);
      create index if not exists idx_spans_duration on spans(duration_nano);
      create index if not exists idx_spans_status on spans(status_code);

      create table if not exists logs (
        id text primary key,
        trace_id text,
        span_id text,
        service_name text not null,
        severity_number integer,
        severity_text text,
        time_unix_nano text,
        observed_time_unix_nano text,
        body_text text,
        body_json text,
        resource_json text not null,
        scope_json text not null,
        attributes_json text not null,
        batch_id text not null
      );
      create index if not exists idx_logs_service_time on logs(service_name, time_unix_nano);
      create index if not exists idx_logs_trace on logs(trace_id);
      create index if not exists idx_logs_severity on logs(severity_number);

      create table if not exists metric_points (
        id text primary key,
        service_name text not null,
        meter_name text not null,
        metric_name text not null,
        metric_type text not null,
        description text,
        unit text,
        temporality integer,
        is_monotonic integer,
        start_time_unix_nano text,
        time_unix_nano text not null,
        value_real real,
        count_value real,
        sum_value real,
        min_value real,
        max_value real,
        attributes_hash text not null,
        attributes_json text not null,
        exemplars_json text not null,
        batch_id text not null
      );
      create index if not exists idx_metric_name_time on metric_points(metric_name, time_unix_nano);
      create index if not exists idx_metric_service_time on metric_points(service_name, time_unix_nano);

      create table if not exists trace_summaries (
        trace_id text primary key,
        root_span_id text,
        root_name text not null,
        start_time_unix_nano text not null,
        end_time_unix_nano text not null,
        duration_nano integer not null,
        service_names text not null,
        span_count integer not null,
        error_count integer not null,
        genai_span_count integer not null,
        input_tokens integer,
        output_tokens integer,
        first_error_message text,
        updated_at integer not null
      );
      create index if not exists idx_trace_summaries_start on trace_summaries(start_time_unix_nano);
      create index if not exists idx_trace_summaries_duration on trace_summaries(duration_nano);
      create index if not exists idx_trace_summaries_error on trace_summaries(error_count);
    `);
  }

  private insertBatch(raw: RawOtlpBatch) {
    this.insertBatchStmt.run(
      raw.id,
      raw.signal,
      raw.protocol,
      raw.receivedAt,
      raw.contentType,
      raw.contentEncoding ?? null,
      raw.bodySize,
      raw.bodyBase64 ? Buffer.from(raw.bodyBase64, "base64") : null,
      raw.rawJson === undefined ? null : JSON.stringify(raw.rawJson),
      JSON.stringify(raw.resourceServiceNames)
    );
  }

  private insertSpan(span: NormalizedSpan) {
    this.insertSpanStmt.run(
      span.traceId,
      span.spanId,
      span.parentSpanId ?? null,
      span.serviceName,
      span.name,
      span.kind ?? null,
      span.startTimeUnixNano,
      span.endTimeUnixNano,
      span.durationNano,
      span.statusCode ?? null,
      span.statusMessage ?? null,
      JSON.stringify(span.resource),
      JSON.stringify(span.scope),
      JSON.stringify(span.attributes),
      JSON.stringify(span.events),
      JSON.stringify(span.links),
      span.batchId
    );
  }

  private insertLog(log: NormalizedLogRecord) {
    this.insertLogStmt.run(
      log.id,
      log.traceId ?? null,
      log.spanId ?? null,
      log.serviceName,
      log.severityNumber ?? null,
      log.severityText ?? null,
      log.timeUnixNano ?? null,
      log.observedTimeUnixNano ?? null,
      log.bodyText ?? null,
      log.bodyJson === undefined ? null : JSON.stringify(log.bodyJson),
      JSON.stringify(log.resource),
      JSON.stringify(log.scope),
      JSON.stringify(log.attributes),
      log.batchId
    );
  }

  private insertMetric(metric: NormalizedMetricPoint) {
    this.insertMetricStmt.run(
      metric.id,
      metric.serviceName,
      metric.meterName,
      metric.metricName,
      metric.metricType,
      metric.description ?? null,
      metric.unit ?? null,
      metric.temporality ?? null,
      metric.isMonotonic === undefined ? null : Number(metric.isMonotonic),
      metric.startTimeUnixNano ?? null,
      metric.timeUnixNano,
      metric.value ?? null,
      metric.count ?? null,
      metric.sum ?? null,
      metric.min ?? null,
      metric.max ?? null,
      metric.attributesHash,
      JSON.stringify(metric.attributes),
      JSON.stringify(metric.exemplars),
      metric.batchId
    );
  }

  private canInsertMetric(metric: NormalizedMetricPoint) {
    const existing = this.db.prepare(`
      select 1 from metric_points
      where service_name = ? and meter_name = ? and metric_name = ? and metric_type = ? and attributes_hash = ?
      limit 1
    `).get(metric.serviceName, metric.meterName, metric.metricName, metric.metricType, metric.attributesHash);
    if (existing) {
      return true;
    }
    const row = this.db.prepare(`
      select count(distinct attributes_hash) as count
      from metric_points
      where service_name = ? and meter_name = ? and metric_name = ? and metric_type = ?
    `).get(metric.serviceName, metric.meterName, metric.metricName, metric.metricType) as { count: number } | undefined;
    return Number(row?.count ?? 0) < this.maxMetricAttributeSets;
  }

  private refreshTraceSummary(traceId: string) {
    const spans = (this.db.prepare("select * from spans where trace_id = ? order by start_time_unix_nano")
      .all(traceId) as unknown as SpanRow[]).map(spanFromRow);
    const root = spans.find((span) => !span.parentSpanId) ?? spans[0];
    if (!root) {
      return;
    }

    const start = spans.reduce((min, span) => Math.min(min, Number(span.startTimeUnixNano)), Number(root.startTimeUnixNano));
    const end = spans.reduce((max, span) => Math.max(max, Number(span.endTimeUnixNano)), Number(root.endTimeUnixNano));
    const errors = spans.filter((span) => Number(span.statusCode ?? 0) >= 2);
    const genAi = summarizeGenAi(spans);
    const services = [...new Set(spans.map((span) => span.serviceName))].sort();

    this.upsertSummaryStmt.run(
      traceId,
      root.spanId,
      root.name,
      String(start),
      String(end),
      Math.max(0, end - start),
      JSON.stringify(services),
      spans.length,
      errors.length,
      genAi.spans.length,
      genAi.inputTokens ?? null,
      genAi.outputTokens ?? null,
      errors[0]?.statusMessage ?? null,
      Date.now()
    );
  }

  private deleteByTime(table: string, columnExpression: string, minNano: string) {
    const before = count(this.db, table);
    this.db.prepare(`delete from ${table} where ${columnExpression} < ?`).run(minNano);
    return before - count(this.db, table);
  }

  private deleteOverflow(table: string, orderExpression: string, limit: number) {
    const before = count(this.db, table);
    this.db.prepare(`delete from ${table} where rowid in (select rowid from ${table} order by ${orderExpression} desc limit -1 offset ?)`).run(limit);
    return before - count(this.db, table);
  }

  private deleteTrace(traceId: string) {
    const before = count(this.db, "spans") + count(this.db, "logs") + count(this.db, "trace_summaries");
    this.db.prepare("delete from spans where trace_id = ?").run(traceId);
    this.db.prepare("delete from logs where trace_id = ?").run(traceId);
    this.db.prepare("delete from trace_summaries where trace_id = ?").run(traceId);
    const after = count(this.db, "spans") + count(this.db, "logs") + count(this.db, "trace_summaries");
    return before - after;
  }

  private deleteEmptyTraceSummaries() {
    this.db.exec("delete from trace_summaries where trace_id not in (select distinct trace_id from spans)");
  }

  private enforceDbSize(maxDbSizeBytes: number) {
    let deleted = 0;
    let guard = 0;
    this.compactDatabase();
    while (this.databaseSizeBytes() > maxDbSizeBytes && guard < 1_000) {
      guard += 1;
      const trace = this.db.prepare("select trace_id from trace_summaries order by start_time_unix_nano asc limit 1").get() as { trace_id: string } | undefined;
      if (trace) {
        deleted += this.deleteTrace(trace.trace_id);
      } else if (count(this.db, "logs") > 0) {
        deleted += this.deleteOverflow("logs", "coalesce(time_unix_nano, observed_time_unix_nano, '0')", Math.max(0, count(this.db, "logs") - 1));
      } else if (count(this.db, "metric_points") > 0) {
        deleted += this.deleteOverflow("metric_points", "time_unix_nano", Math.max(0, count(this.db, "metric_points") - 1));
      } else {
        break;
      }
      this.compactDatabase();
    }
    return deleted;
  }

  private compactDatabase() {
    this.db.exec("pragma wal_checkpoint(TRUNCATE); vacuum;");
  }

  private databaseSizeBytes() {
    return [this.dbPath, `${this.dbPath}-wal`, `${this.dbPath}-shm`].reduce((sum, file) => {
      return sum + (existsSync(file) ? statSync(file).size : 0);
    }, 0);
  }
}

interface SpanRow {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  service_name: string;
  name: string;
  kind: number | null;
  start_time_unix_nano: string;
  end_time_unix_nano: string;
  duration_nano: number;
  status_code: number | null;
  status_message: string | null;
  resource_json: string;
  scope_json: string;
  attributes_json: string;
  events_json: string;
  links_json: string;
  batch_id: string;
}

interface LogRow {
  id: string;
  trace_id: string | null;
  span_id: string | null;
  service_name: string;
  severity_number: number | null;
  severity_text: string | null;
  time_unix_nano: string | null;
  observed_time_unix_nano: string | null;
  body_text: string | null;
  body_json: string | null;
  resource_json: string;
  scope_json: string;
  attributes_json: string;
  batch_id: string;
}

interface MetricDescriptorRow {
  serviceName: string;
  meterName: string;
  metricName: string;
  metricType: string;
  description: string | null;
  unit: string | null;
  pointCount: number;
  lastSeenNano: string | null;
  attributeSets: number;
}

interface MetricPointRow {
  id: string;
  service_name: string;
  meter_name: string;
  metric_name: string;
  metric_type: string;
  description: string | null;
  unit: string | null;
  temporality: number | null;
  is_monotonic: number | null;
  start_time_unix_nano: string | null;
  time_unix_nano: string;
  value_real: number | null;
  count_value: number | null;
  sum_value: number | null;
  min_value: number | null;
  max_value: number | null;
  attributes_hash: string;
  attributes_json: string;
  exemplars_json: string;
  batch_id: string;
}

interface SummaryRow {
  trace_id: string;
  root_span_id: string | null;
  root_name: string;
  start_time_unix_nano: string;
  end_time_unix_nano: string;
  duration_nano: number;
  service_names: string;
  span_count: number;
  error_count: number;
  genai_span_count: number;
  input_tokens: number | null;
  output_tokens: number | null;
  first_error_message: string | null;
}

function spanFromRow(row: SpanRow): NormalizedSpan {
  return {
    traceId: row.trace_id,
    spanId: row.span_id,
    parentSpanId: row.parent_span_id ?? undefined,
    serviceName: row.service_name,
    name: row.name,
    kind: row.kind ?? undefined,
    startTimeUnixNano: row.start_time_unix_nano,
    endTimeUnixNano: row.end_time_unix_nano,
    durationNano: row.duration_nano,
    statusCode: row.status_code ?? undefined,
    statusMessage: row.status_message ?? undefined,
    resource: parseJson(row.resource_json, {}),
    scope: parseJson(row.scope_json, {}),
    attributes: parseJson(row.attributes_json, {}),
    events: parseJson(row.events_json, []),
    links: parseJson(row.links_json, []),
    batchId: row.batch_id
  };
}

function logFromRow(row: LogRow): NormalizedLogRecord {
  return {
    id: row.id,
    traceId: row.trace_id ?? undefined,
    spanId: row.span_id ?? undefined,
    serviceName: row.service_name,
    severityNumber: row.severity_number ?? undefined,
    severityText: row.severity_text ?? undefined,
    timeUnixNano: row.time_unix_nano ?? undefined,
    observedTimeUnixNano: row.observed_time_unix_nano ?? undefined,
    bodyText: row.body_text ?? undefined,
    bodyJson: row.body_json ? parseJson(row.body_json, undefined) : undefined,
    resource: parseJson(row.resource_json, {}),
    scope: parseJson(row.scope_json, {}),
    attributes: parseJson(row.attributes_json, {}),
    batchId: row.batch_id
  };
}

function metricDescriptorFromRow(row: MetricDescriptorRow): MetricDescriptor {
  return {
    serviceName: row.serviceName,
    meterName: row.meterName,
    metricName: row.metricName,
    metricType: row.metricType,
    description: row.description ?? undefined,
    unit: row.unit ?? undefined,
    pointCount: row.pointCount,
    lastSeen: Number(row.lastSeenNano ?? 0) / 1_000_000,
    attributeSets: row.attributeSets
  };
}

function metricPointFromRow(row: MetricPointRow): NormalizedMetricPoint {
  return {
    id: row.id,
    serviceName: row.service_name,
    meterName: row.meter_name,
    metricName: row.metric_name,
    metricType: row.metric_type,
    description: row.description ?? undefined,
    unit: row.unit ?? undefined,
    temporality: row.temporality ?? undefined,
    isMonotonic: row.is_monotonic === null ? undefined : Boolean(row.is_monotonic),
    startTimeUnixNano: row.start_time_unix_nano ?? undefined,
    timeUnixNano: row.time_unix_nano,
    value: row.value_real ?? undefined,
    count: row.count_value ?? undefined,
    sum: row.sum_value ?? undefined,
    min: row.min_value ?? undefined,
    max: row.max_value ?? undefined,
    attributesHash: row.attributes_hash,
    attributes: parseJson(row.attributes_json, {}),
    exemplars: parseJson(row.exemplars_json, []),
    batchId: row.batch_id
  };
}

function summaryFromRow(row: SummaryRow): TraceSummary {
  return {
    traceId: row.trace_id,
    rootSpanId: row.root_span_id ?? undefined,
    rootName: row.root_name,
    startTimeUnixNano: row.start_time_unix_nano,
    endTimeUnixNano: row.end_time_unix_nano,
    durationNano: row.duration_nano,
    serviceNames: parseJson(row.service_names, []),
    spanCount: row.span_count,
    errorCount: row.error_count,
    genAiSpanCount: row.genai_span_count,
    inputTokens: row.input_tokens ?? undefined,
    outputTokens: row.output_tokens ?? undefined,
    firstErrorMessage: row.first_error_message ?? undefined
  };
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function count(db: DatabaseSync, table: string) {
  const row = db.prepare(`select count(*) as value from ${table}`).get() as { value: number };
  return row.value;
}
