#!/usr/bin/env bash
set -euo pipefail

OTLP_ENDPOINT="${OTLP_ENDPOINT:-http://127.0.0.1:4318}"

curl -sS -X POST "${OTLP_ENDPOINT}/v1/traces" \
  -H 'content-type: application/json' \
  --data '{
    "resourceSpans": [{
      "resource": {
        "attributes": [
          { "key": "service.name", "value": { "stringValue": "checkout-api" } }
        ]
      },
      "scopeSpans": [{
        "scope": { "name": "smoke" },
        "spans": [{
          "traceId": "11111111111111111111111111111111",
          "spanId": "2222222222222222",
          "name": "POST /orders",
          "kind": 2,
          "startTimeUnixNano": "1715840000000000000",
          "endTimeUnixNano": "1715840000840000000",
          "attributes": [
            { "key": "http.route", "value": { "stringValue": "/orders" } },
            { "key": "gen_ai.system", "value": { "stringValue": "openai" } },
            { "key": "gen_ai.request.model", "value": { "stringValue": "gpt-4.1" } },
            { "key": "gen_ai.usage.input_tokens", "value": { "intValue": "812" } },
            { "key": "gen_ai.usage.output_tokens", "value": { "intValue": "146" } }
          ],
          "status": { "code": 1 }
        }]
      }]
    }]
  }'

printf '\n'

curl -sS -X POST "${OTLP_ENDPOINT}/v1/logs" \
  -H 'content-type: application/json' \
  --data '{
    "resourceLogs": [{
      "resource": {
        "attributes": [
          { "key": "service.name", "value": { "stringValue": "checkout-api" } }
        ]
      },
      "scopeLogs": [{
        "scope": { "name": "smoke" },
        "logRecords": [{
          "timeUnixNano": "1715840000420000000",
          "severityText": "INFO",
          "body": { "stringValue": "created order draft" },
          "traceId": "11111111111111111111111111111111",
          "spanId": "2222222222222222",
          "attributes": [
            { "key": "order.id", "value": { "stringValue": "ord_123" } }
          ]
        }]
      }]
    }]
  }'

printf '\n'

curl -sS -X POST "${OTLP_ENDPOINT}/v1/metrics" \
  -H 'content-type: application/json' \
  --data '{
    "resourceMetrics": [{
      "resource": {
        "attributes": [
          { "key": "service.name", "value": { "stringValue": "checkout-api" } }
        ]
      },
      "scopeMetrics": [{
        "scope": { "name": "smoke-meter" },
        "metrics": [{
          "name": "http.server.duration",
          "description": "HTTP server duration",
          "unit": "ms",
          "gauge": {
            "dataPoints": [
              {
                "timeUnixNano": "1715840000500000000",
                "asDouble": 12.5,
                "attributes": [{ "key": "route", "value": { "stringValue": "/orders" } }]
              },
              {
                "timeUnixNano": "1715840000600000000",
                "asDouble": 18.25,
                "attributes": [{ "key": "route", "value": { "stringValue": "/orders" } }]
              }
            ]
          }
        }]
      }]
    }]
  }'

printf '\nSent smoke trace/log/metric to %s\n' "${OTLP_ENDPOINT}"
