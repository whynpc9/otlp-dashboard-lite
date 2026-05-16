import { nanoid } from "nanoid";
import type { AttributeMap, IngestBatch, NormalizedLogRecord, NormalizedMetricPoint, NormalizedSpan, OtlpProtocol, RawOtlpBatch, TelemetrySignal } from "../store/types.js";
import {
  decodeProtoMessage,
  fixed64Field,
  hexBytesField,
  repeatedNested,
  stringField,
  varintField,
  type ProtoMessage
} from "../otlp/protobufReader.js";
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
  const request = decodeProtoMessage(body);
  const result: NormalizedSpan[] = [];

  for (const resourceSpans of repeatedNested(request, 1)) {
    const resource = readResource(resourceSpans);
    const serviceName = serviceNameFrom(resource);
    for (const scopeSpans of repeatedNested(resourceSpans, 2)) {
      const scope = readScope(scopeSpans);
      for (const span of repeatedNested(scopeSpans, 2)) {
        const start = String(fixed64Field(span, 7) ?? 0n);
        const end = String(fixed64Field(span, 8) ?? fixed64Field(span, 7) ?? 0n);
        result.push({
          traceId: hexBytesField(span, 1) ?? "",
          spanId: hexBytesField(span, 2) ?? "",
          parentSpanId: hexBytesField(span, 4),
          serviceName,
          name: stringField(span, 5) ?? "(unnamed span)",
          kind: numberFromBigint(varintField(span, 6)),
          startTimeUnixNano: start,
          endTimeUnixNano: end,
          durationNano: durationNano(start, end),
          statusCode: readStatusCode(span),
          statusMessage: readStatusMessage(span),
          resource,
          scope,
          attributes: readAttributes(span, 9),
          events: repeatedNested(span, 11).map(readSpanEvent),
          links: repeatedNested(span, 13).map(readSpanLink),
          batchId
        });
      }
    }
  }

  return result.filter((span) => span.traceId && span.spanId);
}

function normalizeLogsProto(body: Uint8Array, batchId: string): NormalizedLogRecord[] {
  const request = decodeProtoMessage(body);
  const result: NormalizedLogRecord[] = [];

  for (const resourceLogs of repeatedNested(request, 1)) {
    const resource = readResource(resourceLogs);
    const serviceName = serviceNameFrom(resource);
    for (const scopeLogs of repeatedNested(resourceLogs, 2)) {
      const scope = readScope(scopeLogs);
      for (const log of repeatedNested(scopeLogs, 2)) {
        const bodyValue = readAnyValueFromField(log, 5);
        const safeBody = redactLogBody(bodyValue);
        result.push({
          id: nanoid(12),
          traceId: hexBytesField(log, 9),
          spanId: hexBytesField(log, 10),
          serviceName,
          severityNumber: numberFromBigint(varintField(log, 2)),
          severityText: stringField(log, 3),
          timeUnixNano: stringFromBigint(fixed64Field(log, 1)),
          observedTimeUnixNano: stringFromBigint(fixed64Field(log, 11)),
          bodyText: typeof safeBody === "string" ? safeBody : undefined,
          bodyJson: typeof safeBody === "string" ? undefined : safeBody,
          resource,
          scope,
          attributes: readAttributes(log, 6),
          batchId
        });
      }
    }
  }

  return result;
}

function normalizeMetricsProto(body: Uint8Array, batchId: string): NormalizedMetricPoint[] {
  const request = decodeProtoMessage(body);
  const result: NormalizedMetricPoint[] = [];

  for (const resourceMetrics of repeatedNested(request, 1)) {
    const resource = readResource(resourceMetrics);
    const serviceName = serviceNameFrom(resource);
    for (const scopeMetrics of repeatedNested(resourceMetrics, 2)) {
      const scope = readScope(scopeMetrics);
      const meterName = typeof scope.name === "string" ? scope.name : "unknown-meter";
      for (const metric of repeatedNested(scopeMetrics, 2)) {
        const metricName = stringField(metric, 1) ?? "unknown.metric";
        const description = stringField(metric, 2);
        const unit = stringField(metric, 3);
        const gauge = repeatedNested(metric, 5)[0];
        const sum = repeatedNested(metric, 7)[0];

        if (gauge) {
          for (const point of repeatedNested(gauge, 1)) {
            result.push(numberDataPointToMetric({ point, serviceName, meterName, metricName, metricType: "gauge", description, unit, batchId }));
          }
        }
        if (sum) {
          const temporality = numberFromBigint(varintField(sum, 2));
          const isMonotonic = varintField(sum, 3) === 1n;
          for (const point of repeatedNested(sum, 1)) {
            result.push(numberDataPointToMetric({ point, serviceName, meterName, metricName, metricType: "sum", description, unit, temporality, isMonotonic, batchId }));
          }
        }
      }
    }
  }

  return result;
}

function readResource(container: ProtoMessage): AttributeMap {
  const resource = repeatedNested(container, 1)[0];
  return resource ? readAttributes(resource, 1) : {};
}

function readScope(container: ProtoMessage): AttributeMap {
  const scope = repeatedNested(container, 1)[0];
  if (!scope) {
    return {};
  }
  return {
    name: stringField(scope, 1),
    version: stringField(scope, 2),
    attributes: readAttributes(scope, 3)
  };
}

function readAttributes(message: ProtoMessage, fieldNumber: number): AttributeMap {
  const attrs: AttributeMap = {};
  for (const attr of repeatedNested(message, fieldNumber)) {
    const key = stringField(attr, 1);
    if (!key) {
      continue;
    }
    attrs[key] = readAnyValueFromField(attr, 2);
  }
  return attrs;
}

function readAnyValueFromField(message: ProtoMessage, fieldNumber: number): unknown {
  const value = repeatedNested(message, fieldNumber)[0];
  if (!value) {
    return undefined;
  }
  const stringValue = stringField(value, 1);
  if (stringValue !== undefined) {
    return stringValue;
  }
  const boolValue = varintField(value, 2);
  if (boolValue !== undefined) {
    return boolValue !== 0n;
  }
  const intValue = varintField(value, 3);
  if (intValue !== undefined) {
    return Number(intValue);
  }
  const doubleValue = fixed64Field(value, 4);
  if (doubleValue !== undefined) {
    const buffer = new ArrayBuffer(8);
    new DataView(buffer).setBigUint64(0, doubleValue, true);
    return new DataView(buffer).getFloat64(0, true);
  }
  const arrayValue = repeatedNested(value, 5)[0];
  if (arrayValue) {
    return repeatedNested(arrayValue, 1).map((item) => readAnyValueMessage(item));
  }
  const kvListValue = repeatedNested(value, 6)[0];
  if (kvListValue) {
    return readAttributes(kvListValue, 1);
  }
  return undefined;
}

function readAnyValueMessage(value: ProtoMessage): unknown {
  const wrapper: ProtoMessage = new Map([[2, [{ wireType: 2, value: encodeNestedUnsupported(value) }]]]);
  return readAnyValueFromField(wrapper, 2);
}

function encodeNestedUnsupported(_value: ProtoMessage): Uint8Array {
  return new Uint8Array();
}

function readSpanEvent(event: ProtoMessage) {
  return {
    timeUnixNano: stringFromBigint(fixed64Field(event, 1)),
    name: stringField(event, 2),
    attributes: readAttributes(event, 3)
  };
}

function readSpanLink(link: ProtoMessage) {
  return {
    traceId: hexBytesField(link, 1),
    spanId: hexBytesField(link, 2),
    attributes: readAttributes(link, 4)
  };
}

function readStatusCode(span: ProtoMessage): number | undefined {
  const status = repeatedNested(span, 15)[0];
  return status ? numberFromBigint(varintField(status, 3)) : undefined;
}

function readStatusMessage(span: ProtoMessage): string | undefined {
  const status = repeatedNested(span, 15)[0];
  return status ? stringField(status, 2) : undefined;
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
      batchId
    };
  });
}

function metricPayload(metric: Record<string, unknown>): [string, Record<string, unknown> | undefined] {
  for (const type of ["gauge", "sum", "histogram", "exponentialHistogram", "summary"]) {
    if (metric[type] && typeof metric[type] === "object") {
      return [type, metric[type] as Record<string, unknown>];
    }
  }
  return ["unknown", undefined];
}

function numberDataPointToMetric(input: {
  point: ProtoMessage;
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
  const attributes = readAttributes(input.point, 7);
  const intValue = numberFromBigint(varintField(input.point, 6));
  const doubleValue = fixed64Field(input.point, 4);
  const value = intValue ?? (doubleValue === undefined ? undefined : fixed64ToDouble(doubleValue));
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
    startTimeUnixNano: stringFromBigint(fixed64Field(input.point, 2)),
    timeUnixNano: stringFromBigint(fixed64Field(input.point, 3)) ?? String(Date.now() * 1_000_000),
    value,
    attributesHash: hashAttributes(attributes),
    attributes,
    exemplars: [],
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

function fixed64ToDouble(value: bigint): number {
  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setBigUint64(0, value, true);
  return new DataView(buffer).getFloat64(0, true);
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

function numberFromBigint(value: bigint | undefined): number | undefined {
  return value === undefined ? undefined : Number(value);
}

function stringFromBigint(value: bigint | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
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
