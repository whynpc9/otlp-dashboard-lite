import { nanoid } from "nanoid";
import { fromBinary } from "@bufbuild/protobuf";
import { ExportLogsServiceRequestSchema } from "@devdash/otel-proto/generated/opentelemetry/proto/collector/logs/v1/logs_service_pb";
import { ExportMetricsServiceRequestSchema } from "@devdash/otel-proto/generated/opentelemetry/proto/collector/metrics/v1/metrics_service_pb";
import { ExportTraceServiceRequestSchema } from "@devdash/otel-proto/generated/opentelemetry/proto/collector/trace/v1/trace_service_pb";
import type { AnyValue, InstrumentationScope, KeyValue } from "@devdash/otel-proto/generated/opentelemetry/proto/common/v1/common_pb";
import type {
  Exemplar,
  ExponentialHistogramDataPoint,
  HistogramDataPoint,
  Metric as OtlpMetric,
  NumberDataPoint,
  SummaryDataPoint
} from "@devdash/otel-proto/generated/opentelemetry/proto/metrics/v1/metrics_pb";
import type { Resource } from "@devdash/otel-proto/generated/opentelemetry/proto/resource/v1/resource_pb";
import type { Span as OtlpSpan, Span_Event, Span_Link } from "@devdash/otel-proto/generated/opentelemetry/proto/trace/v1/trace_pb";
import type { AttributeMap, IngestBatch, NormalizedLogRecord, NormalizedMetricPoint, NormalizedSpan, OtlpProtocol, RawOtlpBatch, TelemetrySignal } from "../store/types.js";
import { redactAttribute, redactLogBody } from "./redact.js";

interface DecodeContext {
  signal: TelemetrySignal;
  protocol: OtlpProtocol;
  receivedAt: number;
  contentType: string;
  contentEncoding?: string | undefined;
  body: Buffer;
  parsed?: unknown;
}

export function normalizeOtlpBatch(context: DecodeContext): IngestBatch {
  const batchId = nanoid(12);
  const raw: RawOtlpBatch = {
    id: batchId,
    signal: context.signal,
    protocol: context.protocol,
    receivedAt: context.receivedAt,
    contentType: context.contentType,
    contentEncoding: context.contentEncoding,
    bodySize: context.body.byteLength,
    bodyBase64: context.body.toString("base64"),
    resourceServiceNames: [],
    rawJson: context.protocol === "http/json" ? context.parsed : undefined
  };

  const spans: NormalizedSpan[] = [];
  const logs: NormalizedLogRecord[] = [];
  const metrics: NormalizedMetricPoint[] = [];

  if (context.signal === "traces") {
    spans.push(...normalizeTracePayload(context, batchId));
  }
  if (context.signal === "logs") {
    logs.push(...normalizeLogPayload(context, batchId));
  }
  if (context.signal === "metrics") {
    metrics.push(...normalizeMetricPayload(context, batchId));
  }

  raw.resourceServiceNames = [...new Set([...spans.map((span) => span.serviceName), ...logs.map((log) => log.serviceName), ...metrics.map((metric) => metric.serviceName)])];
  return { raw, spans, logs, metrics };
}

function normalizeTracePayload(context: DecodeContext, batchId: string): NormalizedSpan[] {
  if (context.protocol === "http/json") {
    return normalizeTraceJson(context.parsed, batchId);
  }
  return normalizeTraceProto(context.body, batchId);
}

function normalizeLogPayload(context: DecodeContext, batchId: string): NormalizedLogRecord[] {
  if (context.protocol === "http/json") {
    return normalizeLogsJson(context.parsed, batchId);
  }
  return normalizeLogsProto(context.body, batchId);
}

function normalizeMetricPayload(context: DecodeContext, batchId: string): NormalizedMetricPoint[] {
  if (context.protocol === "http/json") {
    return normalizeMetricsJson(context.parsed, batchId);
  }
  return normalizeMetricsProto(context.body, batchId);
}

function normalizeTraceJson(payload: unknown, batchId: string): NormalizedSpan[] {
  const root = payload as { resourceSpans?: unknown[] };
  const result: NormalizedSpan[] = [];

  for (const resourceSpan of root.resourceSpans ?? []) {
    const rs = resourceSpan as Record<string, unknown>;
    const resource = attributesToMap((rs.resource as Record<string, unknown> | undefined)?.attributes);
    const serviceName = serviceNameFrom(resource);
    const scopeSpans = (rs.scopeSpans ?? rs.instrumentationLibrarySpans ?? []) as Array<Record<string, unknown>>;

    for (const scopeSpan of scopeSpans) {
      const scope = scopeSpan.scope as AttributeMap | undefined ?? {};
      for (const span of (scopeSpan.spans as Array<Record<string, unknown>> | undefined) ?? []) {
        const start = String(span.startTimeUnixNano ?? "0");
        const end = String(span.endTimeUnixNano ?? start);
        result.push({
          traceId: normalizeHex(String(span.traceId ?? "")),
          spanId: normalizeHex(String(span.spanId ?? "")),
          parentSpanId: span.parentSpanId ? normalizeHex(String(span.parentSpanId)) : undefined,
          serviceName,
          name: String(span.name ?? "(unnamed span)"),
          kind: numberOrUndefined(span.kind),
          startTimeUnixNano: start,
          endTimeUnixNano: end,
          durationNano: durationNano(start, end),
          statusCode: numberOrUndefined((span.status as Record<string, unknown> | undefined)?.code),
          statusMessage: stringOrUndefined((span.status as Record<string, unknown> | undefined)?.message),
          resource,
          scope,
          attributes: attributesToMap(span.attributes),
          events: arrayOrEmpty(span.events),
          links: arrayOrEmpty(span.links),
          batchId
        });
      }
    }
  }

  return result.filter((span) => span.traceId && span.spanId);
}

function normalizeLogsJson(payload: unknown, batchId: string): NormalizedLogRecord[] {
  const root = payload as { resourceLogs?: unknown[] };
  const result: NormalizedLogRecord[] = [];

  for (const resourceLog of root.resourceLogs ?? []) {
    const rl = resourceLog as Record<string, unknown>;
    const resource = attributesToMap((rl.resource as Record<string, unknown> | undefined)?.attributes);
    const serviceName = serviceNameFrom(resource);
    const scopeLogs = (rl.scopeLogs ?? rl.instrumentationLibraryLogs ?? []) as Array<Record<string, unknown>>;

    for (const scopeLog of scopeLogs) {
      const scope = scopeLog.scope as AttributeMap | undefined ?? {};
      for (const log of (scopeLog.logRecords as Array<Record<string, unknown>> | undefined) ?? []) {
        const body = anyValueJson(log.body);
        const safeBody = redactLogBody(body);
        result.push({
          id: nanoid(12),
          traceId: log.traceId ? normalizeHex(String(log.traceId)) : undefined,
          spanId: log.spanId ? normalizeHex(String(log.spanId)) : undefined,
          serviceName,
          severityNumber: numberOrUndefined(log.severityNumber),
          severityText: stringOrUndefined(log.severityText),
          timeUnixNano: stringOrUndefined(log.timeUnixNano),
          observedTimeUnixNano: stringOrUndefined(log.observedTimeUnixNano),
          bodyText: typeof safeBody === "string" ? safeBody : undefined,
          bodyJson: typeof safeBody === "string" ? undefined : safeBody,
          resource,
          scope,
          attributes: attributesToMap(log.attributes),
          batchId
        });
      }
    }
  }

  return result;
}

function normalizeMetricsJson(payload: unknown, batchId: string): NormalizedMetricPoint[] {
  const root = payload as { resourceMetrics?: unknown[] };
  const result: NormalizedMetricPoint[] = [];

  for (const resourceMetric of root.resourceMetrics ?? []) {
    const rm = resourceMetric as Record<string, unknown>;
    const resource = attributesToMap((rm.resource as Record<string, unknown> | undefined)?.attributes);
    const serviceName = serviceNameFrom(resource);
    const scopeMetrics = (rm.scopeMetrics ?? rm.instrumentationLibraryMetrics ?? []) as Array<Record<string, unknown>>;

    for (const scopeMetric of scopeMetrics) {
      const scope = scopeMetric.scope as Record<string, unknown> | undefined;
      const meterName = String(scope?.name ?? "unknown-meter");
      for (const metric of (scopeMetric.metrics as Array<Record<string, unknown>> | undefined) ?? []) {
        result.push(...metricJsonToPoints(metric, serviceName, meterName, batchId));
      }
    }
  }

  return result;
}

function normalizeTraceProto(body: Uint8Array, batchId: string): NormalizedSpan[] {
  const request = fromBinary(ExportTraceServiceRequestSchema, body);
  const result: NormalizedSpan[] = [];

  for (const resourceSpans of request.resourceSpans) {
    const resource = resourceToMap(resourceSpans.resource);
    const serviceName = serviceNameFrom(resource);
    for (const scopeSpans of resourceSpans.scopeSpans) {
      const scope = scopeToMap(scopeSpans.scope);
      for (const span of scopeSpans.spans) {
        const start = nanoString(span.startTimeUnixNano);
        const end = nanoString(span.endTimeUnixNano || span.startTimeUnixNano);
        result.push({
          traceId: bytesToHex(span.traceId),
          spanId: bytesToHex(span.spanId),
          parentSpanId: optionalHex(span.parentSpanId),
          serviceName,
          name: span.name || "(unnamed span)",
          kind: span.kind,
          startTimeUnixNano: start,
          endTimeUnixNano: end,
          durationNano: durationNano(start, end),
          statusCode: span.status ? span.status.code : undefined,
          statusMessage: span.status?.message || undefined,
          resource,
          scope,
          attributes: keyValuesToMap(span.attributes),
          events: span.events.map(spanEventToJson),
          links: span.links.map(spanLinkToJson),
          batchId
        });
      }
    }
  }

  return result.filter((span) => span.traceId && span.spanId);
}

function normalizeLogsProto(body: Uint8Array, batchId: string): NormalizedLogRecord[] {
  const request = fromBinary(ExportLogsServiceRequestSchema, body);
  const result: NormalizedLogRecord[] = [];

  for (const resourceLogs of request.resourceLogs) {
    const resource = resourceToMap(resourceLogs.resource);
    const serviceName = serviceNameFrom(resource);
    for (const scopeLogs of resourceLogs.scopeLogs) {
      const scope = scopeToMap(scopeLogs.scope);
      for (const log of scopeLogs.logRecords) {
        const bodyValue = anyValueProto(log.body);
        const safeBody = redactLogBody(bodyValue);
        result.push({
          id: nanoid(12),
          traceId: optionalHex(log.traceId),
          spanId: optionalHex(log.spanId),
          serviceName,
          severityNumber: log.severityNumber || undefined,
          severityText: log.severityText || undefined,
          timeUnixNano: optionalNanoString(log.timeUnixNano),
          observedTimeUnixNano: optionalNanoString(log.observedTimeUnixNano),
          bodyText: typeof safeBody === "string" ? safeBody : undefined,
          bodyJson: typeof safeBody === "string" ? undefined : safeBody,
          resource,
          scope,
          attributes: keyValuesToMap(log.attributes),
          batchId
        });
      }
    }
  }

  return result;
}

function normalizeMetricsProto(body: Uint8Array, batchId: string): NormalizedMetricPoint[] {
  const request = fromBinary(ExportMetricsServiceRequestSchema, body);
  const result: NormalizedMetricPoint[] = [];

  for (const resourceMetrics of request.resourceMetrics) {
    const resource = resourceToMap(resourceMetrics.resource);
    const serviceName = serviceNameFrom(resource);
    for (const scopeMetrics of resourceMetrics.scopeMetrics) {
      const scope = scopeToMap(scopeMetrics.scope);
      const meterName = typeof scope.name === "string" ? scope.name : "unknown-meter";
      for (const metric of scopeMetrics.metrics) {
        result.push(...metricProtoToPoints(metric, serviceName, meterName, batchId));
      }
    }
  }

  return result;
}

function metricJsonToPoints(metric: Record<string, unknown>, serviceName: string, meterName: string, batchId: string): NormalizedMetricPoint[] {
  const metricName = String(metric.name ?? "unknown.metric");
  const description = stringOrUndefined(metric.description);
  const unit = stringOrUndefined(metric.unit);
  const [metricType, payload] = metricPayload(metric);
  if (!payload) {
    return [];
  }

  const dataPoints = (payload.dataPoints as Array<Record<string, unknown>> | undefined) ?? [];
  const temporality = numberOrUndefined(payload.aggregationTemporality);
  const isMonotonic = typeof payload.isMonotonic === "boolean" ? payload.isMonotonic : undefined;

  return dataPoints.map((point) => {
    const attributes = attributesToMap(point.attributes);
    const value = numberOrUndefined(point.asDouble) ?? numberOrUndefined(point.asInt);
    const sumValue = numberOrUndefined(point.sum);
    return {
      id: nanoid(12),
      serviceName,
      meterName,
      metricName,
      metricType,
      description,
      unit,
      temporality,
      isMonotonic,
      startTimeUnixNano: stringOrUndefined(point.startTimeUnixNano),
      timeUnixNano: stringOrUndefined(point.timeUnixNano) ?? String(Date.now() * 1_000_000),
      value: value ?? sumValue,
      count: numberOrUndefined(point.count),
      sum: sumValue,
      min: numberOrUndefined(point.min),
      max: numberOrUndefined(point.max),
      attributesHash: hashAttributes(attributes),
      attributes,
      exemplars: arrayOrEmpty(point.exemplars),
      distribution: distributionFromJsonPoint(metricType, point),
      batchId
    };
  });
}

function distributionFromJsonPoint(metricType: string, point: Record<string, unknown>): Record<string, unknown> | undefined {
  if (metricType === "histogram") {
    return {
      kind: "explicit",
      explicitBounds: arrayOfNumbers(point.explicitBounds),
      bucketCounts: arrayOfNumbers(point.bucketCounts)
    };
  }
  if (metricType === "exponentialHistogram") {
    return {
      kind: "exponential",
      scale: numberOrUndefined(point.scale),
      zeroCount: numberOrUndefined(point.zeroCount),
      zeroThreshold: numberOrUndefined(point.zeroThreshold),
      positive: point.positive,
      negative: point.negative
    };
  }
  if (metricType === "summary") {
    return {
      kind: "summary",
      quantiles: point.quantileValues
    };
  }
  return undefined;
}

function metricPayload(metric: Record<string, unknown>): [string, Record<string, unknown> | undefined] {
  for (const type of ["gauge", "sum", "histogram", "exponentialHistogram", "summary"]) {
    if (metric[type] && typeof metric[type] === "object") {
      return [type, metric[type] as Record<string, unknown>];
    }
  }
  return ["unknown", undefined];
}

function metricProtoToPoints(metric: OtlpMetric, serviceName: string, meterName: string, batchId: string): NormalizedMetricPoint[] {
  const metricName = metric.name || "unknown.metric";
  const description = metric.description || undefined;
  const unit = metric.unit || undefined;
  const data = metric.data;
  switch (data.case) {
    case "gauge":
      return data.value.dataPoints.map((point) => numberDataPointToMetric({
        point,
        serviceName,
        meterName,
        metricName,
        metricType: "gauge",
        description,
        unit,
        batchId
      }));
    case "sum":
      return data.value.dataPoints.map((point) => numberDataPointToMetric({
        point,
        serviceName,
        meterName,
        metricName,
        metricType: "sum",
        description,
        unit,
        temporality: data.value.aggregationTemporality,
        isMonotonic: data.value.isMonotonic,
        batchId
      }));
    case "histogram":
      return data.value.dataPoints.map((point) => histogramDataPointToMetric({
        point,
        serviceName,
        meterName,
        metricName,
        metricType: "histogram",
        description,
        unit,
        temporality: data.value.aggregationTemporality,
        batchId
      }));
    case "exponentialHistogram":
      return data.value.dataPoints.map((point) => exponentialHistogramDataPointToMetric({
        point,
        serviceName,
        meterName,
        metricName,
        metricType: "exponentialHistogram",
        description,
        unit,
        temporality: data.value.aggregationTemporality,
        batchId
      }));
    case "summary":
      return data.value.dataPoints.map((point) => summaryDataPointToMetric({
        point,
        serviceName,
        meterName,
        metricName,
        metricType: "summary",
        description,
        unit,
        batchId
      }));
    default:
      return [];
  }
}

function numberDataPointToMetric(input: {
  point: NumberDataPoint;
  serviceName: string;
  meterName: string;
  metricName: string;
  metricType: string;
  description?: string | undefined;
  unit?: string | undefined;
  temporality?: number | undefined;
  isMonotonic?: boolean | undefined;
  batchId: string;
}): NormalizedMetricPoint {
  const attributes = keyValuesToMap(input.point.attributes);
  const value = oneofNumber(input.point.value);
  return {
    id: nanoid(12),
    serviceName: input.serviceName,
    meterName: input.meterName,
    metricName: input.metricName,
    metricType: input.metricType,
    description: input.description,
    unit: input.unit,
    temporality: input.temporality,
    isMonotonic: input.isMonotonic,
    startTimeUnixNano: optionalNanoString(input.point.startTimeUnixNano),
    timeUnixNano: optionalNanoString(input.point.timeUnixNano) ?? String(Date.now() * 1_000_000),
    value,
    attributesHash: hashAttributes(attributes),
    attributes,
    exemplars: exemplarsToJson(input.point.exemplars),
    batchId: input.batchId
  };
}

function histogramDataPointToMetric(input: {
  point: HistogramDataPoint;
  serviceName: string;
  meterName: string;
  metricName: string;
  metricType: string;
  description?: string | undefined;
  unit?: string | undefined;
  temporality?: number | undefined;
  batchId: string;
}): NormalizedMetricPoint {
  const attributes = keyValuesToMap(input.point.attributes);
  return {
    id: nanoid(12),
    serviceName: input.serviceName,
    meterName: input.meterName,
    metricName: input.metricName,
    metricType: input.metricType,
    description: input.description,
    unit: input.unit,
    temporality: input.temporality,
    startTimeUnixNano: optionalNanoString(input.point.startTimeUnixNano),
    timeUnixNano: optionalNanoString(input.point.timeUnixNano) ?? String(Date.now() * 1_000_000),
    value: input.point.sum,
    count: Number(input.point.count),
    sum: input.point.sum,
    min: input.point.min,
    max: input.point.max,
    attributesHash: hashAttributes(attributes),
    attributes,
    exemplars: exemplarsToJson(input.point.exemplars),
    distribution: {
      kind: "explicit",
      explicitBounds: input.point.explicitBounds,
      bucketCounts: input.point.bucketCounts.map(Number)
    },
    batchId: input.batchId
  };
}

function exponentialHistogramDataPointToMetric(input: {
  point: ExponentialHistogramDataPoint;
  serviceName: string;
  meterName: string;
  metricName: string;
  metricType: string;
  description?: string | undefined;
  unit?: string | undefined;
  temporality?: number | undefined;
  batchId: string;
}): NormalizedMetricPoint {
  const attributes = keyValuesToMap(input.point.attributes);
  return {
    id: nanoid(12),
    serviceName: input.serviceName,
    meterName: input.meterName,
    metricName: input.metricName,
    metricType: input.metricType,
    description: input.description,
    unit: input.unit,
    temporality: input.temporality,
    startTimeUnixNano: optionalNanoString(input.point.startTimeUnixNano),
    timeUnixNano: optionalNanoString(input.point.timeUnixNano) ?? String(Date.now() * 1_000_000),
    value: input.point.sum,
    count: Number(input.point.count),
    sum: input.point.sum,
    min: input.point.min,
    max: input.point.max,
    attributesHash: hashAttributes(attributes),
    attributes,
    exemplars: exemplarsToJson(input.point.exemplars),
    distribution: {
      kind: "exponential",
      scale: input.point.scale,
      zeroCount: Number(input.point.zeroCount),
      zeroThreshold: input.point.zeroThreshold,
      positive: input.point.positive ? { offset: input.point.positive.offset, bucketCounts: input.point.positive.bucketCounts.map(Number) } : undefined,
      negative: input.point.negative ? { offset: input.point.negative.offset, bucketCounts: input.point.negative.bucketCounts.map(Number) } : undefined
    },
    batchId: input.batchId
  };
}

function summaryDataPointToMetric(input: {
  point: SummaryDataPoint;
  serviceName: string;
  meterName: string;
  metricName: string;
  metricType: string;
  description?: string | undefined;
  unit?: string | undefined;
  batchId: string;
}): NormalizedMetricPoint {
  const attributes = keyValuesToMap(input.point.attributes);
  return {
    id: nanoid(12),
    serviceName: input.serviceName,
    meterName: input.meterName,
    metricName: input.metricName,
    metricType: input.metricType,
    description: input.description,
    unit: input.unit,
    startTimeUnixNano: optionalNanoString(input.point.startTimeUnixNano),
    timeUnixNano: optionalNanoString(input.point.timeUnixNano) ?? String(Date.now() * 1_000_000),
    value: input.point.sum,
    count: Number(input.point.count),
    sum: input.point.sum,
    min: input.point.quantileValues.find((item) => item.quantile === 0)?.value,
    max: input.point.quantileValues.find((item) => item.quantile === 1)?.value,
    attributesHash: hashAttributes(attributes),
    attributes,
    exemplars: [],
    distribution: {
      kind: "summary",
      quantiles: input.point.quantileValues.map((item) => ({ quantile: item.quantile, value: item.value }))
    },
    batchId: input.batchId
  };
}

function attributesToMap(input: unknown): AttributeMap {
  const attrs: AttributeMap = {};
  if (!Array.isArray(input)) {
    return attrs;
  }
  for (const attr of input) {
    const record = attr as Record<string, unknown>;
    const key = String(record.key ?? "");
    if (!key) {
      continue;
    }
    attrs[key] = redactAttribute(key, anyValueJson(record.value));
  }
  return attrs;
}

function resourceToMap(resource: Resource | undefined): AttributeMap {
  return keyValuesToMap(resource?.attributes ?? []);
}

function scopeToMap(scope: InstrumentationScope | undefined): AttributeMap {
  if (!scope) {
    return {};
  }
  return {
    name: scope.name || undefined,
    version: scope.version || undefined,
    attributes: keyValuesToMap(scope.attributes)
  };
}

function keyValuesToMap(input: KeyValue[]): AttributeMap {
  const attrs: AttributeMap = {};
  for (const attr of input) {
    if (!attr.key) {
      continue;
    }
    attrs[attr.key] = redactAttribute(attr.key, anyValueProto(attr.value));
  }
  return attrs;
}

function anyValueProto(input: AnyValue | undefined): unknown {
  if (!input) {
    return undefined;
  }
  switch (input.value.case) {
    case "stringValue":
    case "boolValue":
    case "doubleValue":
      return input.value.value;
    case "intValue":
      return Number(input.value.value);
    case "arrayValue":
      return input.value.value.values.map(anyValueProto);
    case "kvlistValue":
      return keyValuesToMap(input.value.value.values);
    case "bytesValue":
      return bytesToHex(input.value.value);
    default:
      return undefined;
  }
}

function spanEventToJson(event: Span_Event) {
  return {
    timeUnixNano: nanoString(event.timeUnixNano),
    name: event.name,
    attributes: keyValuesToMap(event.attributes)
  };
}

function spanLinkToJson(link: Span_Link) {
  return {
    traceId: bytesToHex(link.traceId),
    spanId: bytesToHex(link.spanId),
    attributes: keyValuesToMap(link.attributes)
  };
}

function exemplarsToJson(exemplars: Exemplar[]): Array<Record<string, unknown>> {
  return exemplars.map((exemplar) => ({
    timeUnixNano: optionalNanoString(exemplar.timeUnixNano),
    value: oneofNumber(exemplar.value),
    traceId: optionalHex(exemplar.traceId),
    spanId: optionalHex(exemplar.spanId),
    filteredAttributes: keyValuesToMap(exemplar.filteredAttributes)
  }));
}

function oneofNumber(value: { case: "asDouble"; value: number } | { case: "asInt"; value: bigint } | { case: undefined; value?: undefined }): number | undefined {
  if (value.case === "asDouble") return value.value;
  if (value.case === "asInt") return Number(value.value);
  return undefined;
}

function anyValueJson(input: unknown): unknown {
  if (!input || typeof input !== "object") {
    return input;
  }
  const value = input as Record<string, unknown>;
  if ("stringValue" in value) return value.stringValue;
  if ("boolValue" in value) return value.boolValue;
  if ("intValue" in value) return Number(value.intValue);
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("arrayValue" in value) {
    const values = ((value.arrayValue as Record<string, unknown>).values as unknown[] | undefined) ?? [];
    return values.map(anyValueJson);
  }
  if ("kvlistValue" in value) {
    return attributesToMap((value.kvlistValue as Record<string, unknown>).values);
  }
  if ("bytesValue" in value) return value.bytesValue;
  return value;
}

function serviceNameFrom(resource: AttributeMap): string {
  const value = resource["service.name"];
  return typeof value === "string" && value ? value : "unknown-service";
}

function durationNano(start: string, end: string) {
  const duration = Number(end) - Number(start);
  return Number.isFinite(duration) ? Math.max(0, duration) : 0;
}

function normalizeHex(value: string): string {
  return value.replace(/^0x/, "").toLowerCase();
}

function bytesToHex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

function optionalHex(value: Uint8Array): string | undefined {
  const hex = bytesToHex(value);
  return hex ? hex : undefined;
}

function nanoString(value: bigint): string {
  return String(value);
}

function optionalNanoString(value: bigint): string | undefined {
  return value === 0n ? undefined : String(value);
}

function hashAttributes(attributes: AttributeMap): string {
  const stable = Object.keys(attributes)
    .sort()
    .map((key) => `${key}:${JSON.stringify(attributes[key])}`)
    .join("|");
  let hash = 0;
  for (let index = 0; index < stable.length; index += 1) {
    hash = (hash * 31 + stable.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return undefined;
}

function arrayOrEmpty(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value as Array<Record<string, unknown>> : [];
}

function arrayOfNumbers(value: unknown): number[] {
  return Array.isArray(value)
    ? value.map((item) => Number(item)).filter((item) => Number.isFinite(item))
    : [];
}
