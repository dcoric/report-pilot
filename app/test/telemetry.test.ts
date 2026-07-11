import "./helpers/setupEnv";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor
} from "@opentelemetry/sdk-trace-base";

import { loadTelemetryConfig } from "../src/lib/telemetryConfig";
import {
  initializeTelemetry,
  bindTelemetryContext,
  normalizeHttpRoute,
  recordTelemetryCounter,
  recordTelemetryHistogram,
  withTelemetrySpan,
  withHttpServerTelemetry,
  sanitizeTelemetryAttributes
} from "../src/lib/telemetry";

test("telemetry is a no-op by default with standard local OTLP endpoints", async () => {
  const handle = await initializeTelemetry({});

  assert.equal(handle.enabled, false);
  assert.equal(handle.config.serviceName, "report-pilot");
  assert.equal(handle.config.tracesEndpoint, "http://localhost:4318/v1/traces");
  assert.equal(handle.config.metricsEndpoint, "http://localhost:4318/v1/metrics");
  await handle.shutdown();
});

test("telemetry config validates enablement, service identity, endpoints, and sampling", () => {
  const valid = loadTelemetryConfig({
    OTEL_ENABLED: "true",
    OTEL_SERVICE_NAME: "report-pilot-worker",
    OTEL_SERVICE_VERSION: "1.2.3",
    OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.test/otel",
    OTEL_TRACES_SAMPLER_ARG: "0.25",
    OTEL_METRIC_EXPORT_INTERVAL: "5000"
  });

  assert.deepEqual(valid.warnings, []);
  assert.equal(valid.config.enabled, true);
  assert.equal(valid.config.tracesEndpoint, "https://collector.example.test/otel/v1/traces");
  assert.equal(valid.config.metricsEndpoint, "https://collector.example.test/otel/v1/metrics");
  assert.equal(valid.config.samplingRatio, 0.25);
  assert.equal(valid.config.metricExportIntervalMs, 5000);

  const invalid = loadTelemetryConfig({
    OTEL_ENABLED: "true",
    OTEL_EXPORTER_OTLP_ENDPOINT: "file:///tmp/telemetry",
    OTEL_TRACES_SAMPLER_ARG: "2"
  });
  assert.equal(invalid.config.enabled, false);
  assert.equal(invalid.warnings.length, 2);
});

test("telemetry sanitization drops sensitive and unsupported attributes", () => {
  const sanitized = sanitizeTelemetryAttributes({
    "pipeline.stage": "schema_linking",
    outcome: "success",
    "llm.prompt": "private question",
    "db.statement": "SELECT secret FROM customer",
    connection_ref: "postgresql://secret",
    params: { customer_id: 42 },
    retries: 1,
    flags: ["fallback", "repair"],
    unsupported: { nested: true }
  });

  assert.deepEqual(sanitized, {
    "pipeline.stage": "schema_linking",
    outcome: "success",
    retries: 1,
    flags: ["fallback", "repair"]
  });
});

test("telemetry initialization failures degrade to no-op", async () => {
  const handle = await initializeTelemetry({ OTEL_ENABLED: "true" }, {
    createSdk: () => {
      throw new Error("collector setup failed");
    }
  });

  assert.equal(handle.enabled, false);
  await handle.shutdown();
});

test("telemetry shutdown failures are contained", async () => {
  const handle = await initializeTelemetry({ OTEL_ENABLED: "true" }, {
    createSdk: () => ({
      start: () => undefined,
      shutdown: async () => {
        throw new Error("export flush failed");
      }
    })
  });

  assert.equal(handle.enabled, true);
  await handle.shutdown();
});

test("no-op spans and metrics preserve application behavior", async () => {
  const value = await withTelemetrySpan("query.schema.retrieve", {
    "pipeline.stage": "schema_retrieval",
    question: "must not be exported"
  }, async () => 42);
  assert.equal(value, 42);

  const failure = new Error("private provider response");
  await assert.rejects(
    withTelemetrySpan("query.llm.generate", { "pipeline.stage": "generation" }, async () => {
      throw failure;
    }),
    (error) => error === failure
  );

  assert.doesNotThrow(() => {
    recordTelemetryCounter("report_pilot.query.repairs", 1, { provider: "test" });
    recordTelemetryHistogram("report_pilot.query.duration", 12, { outcome: "success" });
    recordTelemetryCounter("report_pilot.query.repairs", Number.NaN);
  });
});

test("HTTP trace context parents pipeline and queued background spans", async () => {
  const exporter = new InMemorySpanExporter();
  const processor = new SimpleSpanProcessor(exporter);
  const sdk = new NodeSDK({
    spanProcessors: [processor],
    metricReaders: [],
    logRecordProcessors: []
  });
  sdk.start();
  const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
  const incomingSpanId = "00f067aa0ba902b7";
  const request = {
    method: "POST",
    url: "/v1/query/sessions/00000000-0000-4000-8000-000000000123/run?debug=true",
    headers: { traceparent: `00-${traceId}-${incomingSpanId}-01` }
  } as unknown as IncomingMessage;
  const response = { statusCode: 200 } as unknown as ServerResponse;
  const queuedWork: { run?: () => Promise<void> } = {};

  await withHttpServerTelemetry(request, response, async () => {
    await withTelemetrySpan("query.run", { "pipeline.stage": "end_to_end" }, async () => undefined);
    queuedWork.run = bindTelemetryContext(() => withTelemetrySpan(
      "background.rag.reindex",
      { "pipeline.stage": "rag_reindex" },
      async () => undefined
    ));
  });
  assert.ok(queuedWork.run);
  await queuedWork.run();
  await processor.forceFlush();

  const spans = exporter.getFinishedSpans();
  const serverSpan = spans.find((span) => span.name === "http.request");
  const querySpan = spans.find((span) => span.name === "query.run");
  const backgroundSpan = spans.find((span) => span.name === "background.rag.reindex");
  assert.ok(serverSpan);
  assert.ok(querySpan);
  assert.ok(backgroundSpan);
  assert.equal(serverSpan.spanContext().traceId, traceId);
  assert.equal(serverSpan.parentSpanContext?.spanId, incomingSpanId);
  assert.equal(querySpan.parentSpanContext?.spanId, serverSpan.spanContext().spanId);
  assert.equal(backgroundSpan.parentSpanContext?.spanId, serverSpan.spanContext().spanId);
  assert.equal(serverSpan.attributes["http.route"], "/v1/query/sessions/{id}/run");
  assert.equal(serverSpan.attributes["http.response.status_code"], 200);
  assert.equal(normalizeHttpRoute("/v1/jobs/123?token=secret"), "/v1/jobs/{id}");

  await sdk.shutdown();
});
