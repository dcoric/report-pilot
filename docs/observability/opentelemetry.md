# OpenTelemetry

Report Pilot can export traces and metrics over OTLP/HTTP. Telemetry is optional
and remains a no-op unless `OTEL_ENABLED=true` is set.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OTEL_ENABLED` | `false` | Explicitly enables SDK initialization. |
| `OTEL_SERVICE_NAME` | `report-pilot` | OpenTelemetry service identity. |
| `OTEL_SERVICE_VERSION` | `0.1.0` | Version resource attribute. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | OTLP/HTTP base endpoint. Signal paths are appended automatically. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | base + `/v1/traces` | Optional exact traces endpoint. |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | base + `/v1/metrics` | Optional exact metrics endpoint. |
| `OTEL_TRACES_SAMPLER_ARG` | `1` | Parent-based trace ID sampling ratio from `0` through `1`. |
| `OTEL_METRIC_EXPORT_INTERVAL` | `60000` | Metric export interval in milliseconds. |

Invalid values disable telemetry and emit a warning. SDK initialization,
export, and shutdown failures are logged but never prevent query processing.

## Local Collector

Run the official Collector image with the checked-in debug configuration:

```bash
docker run --rm \
  -p 4317:4317 \
  -p 4318:4318 \
  -v "$PWD/docs/observability/otel-collector-config.yaml:/etc/otelcol/config.yaml" \
  otel/opentelemetry-collector:latest
```

Then start Report Pilot with:

```bash
OTEL_ENABLED=true \
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
npm run dev:be
```

The debug exporter prints received traces and metrics in the Collector output.
Production deployments should pin the Collector image and replace the debug
exporter with their observability backend.

## Sensitive Data

Report Pilot's telemetry attribute sanitizer drops prompt, question, SQL,
statement, connection, password, secret, token, API-key, parameter, and body
attributes. Attribute strings and arrays are bounded. Prompts, generated SQL,
connection details, and query parameters are not exported by default.

The Collector should apply an additional attribute or redaction processor as a
defense-in-depth control. See the official OpenTelemetry documentation for
[OTLP exporter configuration](https://opentelemetry.io/docs/languages/sdk-configuration/otlp-exporter/),
[JavaScript exporters](https://opentelemetry.io/docs/languages/js/exporters/),
and [handling sensitive data](https://opentelemetry.io/docs/security/handling-sensitive-data/).
