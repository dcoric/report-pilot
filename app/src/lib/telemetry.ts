import {
  metrics,
  SpanStatusCode,
  trace,
  type Attributes,
  type AttributeValue,
  type Counter,
  type Histogram
} from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { ParentBasedSampler, TraceIdRatioBasedSampler } from "@opentelemetry/sdk-trace-base";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION
} from "@opentelemetry/semantic-conventions";
import { loadTelemetryConfig, type TelemetryConfig } from "./telemetryConfig";

export interface TelemetryHandle {
  enabled: boolean;
  config: TelemetryConfig;
  shutdown: () => Promise<void>;
}

export interface TelemetrySdk {
  start: () => void;
  shutdown: () => Promise<void>;
}

export interface TelemetryDependencies {
  createSdk: (config: TelemetryConfig) => TelemetrySdk;
}

const SENSITIVE_ATTRIBUTE = /(prompt|question|sql|statement|connection|password|secret|token|api[_-]?key|parameter|request\.body|response\.body)/i;
const MAX_ATTRIBUTE_LENGTH = 120;
const tracer = trace.getTracer("report-pilot.pipeline", "0.1.0");
const meter = metrics.getMeter("report-pilot.pipeline", "0.1.0");
const counters = new Map<string, Counter>();
const histograms = new Map<string, Histogram>();

export async function initializeTelemetry(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: TelemetryDependencies = { createSdk }
): Promise<TelemetryHandle> {
  const { config, warnings } = loadTelemetryConfig(env);
  for (const warning of warnings) console.warn(`[telemetry] ${warning}`);
  if (!config.enabled) return noOpHandle(config);

  try {
    const sdk = dependencies.createSdk(config);
    sdk.start();
    console.log(`[telemetry] OTLP traces and metrics enabled for ${config.serviceName}`);
    return {
      enabled: true,
      config,
      shutdown: async () => {
        try {
          await sdk.shutdown();
        } catch (error) {
          console.error(`[telemetry] shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    };
  } catch (error) {
    console.error(`[telemetry] initialization failed; continuing without telemetry: ${error instanceof Error ? error.message : String(error)}`);
    return noOpHandle(config);
  }
}

export function sanitizeTelemetryAttributes(
  attributes: Record<string, unknown>
): Attributes {
  const sanitized: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (!key || SENSITIVE_ATTRIBUTE.test(key)) continue;
    const safe = sanitizeAttributeValue(value);
    if (safe !== undefined) sanitized[key.slice(0, 255)] = safe;
  }
  return sanitized;
}

export async function withTelemetrySpan<T>(
  name: string,
  attributes: Record<string, unknown>,
  operation: () => Promise<T>
): Promise<T> {
  const startedAt = performance.now();
  const safeAttributes = sanitizeTelemetryAttributes(attributes);
  return tracer.startActiveSpan(name, { attributes: safeAttributes }, async (span) => {
    let outcome = "success";
    try {
      return await operation();
    } catch (error) {
      outcome = "error";
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.setAttribute("error.type", boundedErrorType(error));
      throw error;
    } finally {
      span.end();
      recordTelemetryHistogram("report_pilot.pipeline.stage.duration", performance.now() - startedAt, {
        ...safeAttributes,
        outcome
      });
      recordTelemetryCounter("report_pilot.pipeline.stage.calls", 1, {
        ...safeAttributes,
        outcome
      });
    }
  });
}

export function recordTelemetryCounter(
  name: string,
  value: number,
  attributes: Record<string, unknown> = {}
): void {
  if (!Number.isFinite(value) || value < 0) return;
  try {
    let counter = counters.get(name);
    if (!counter) {
      counter = meter.createCounter(name);
      counters.set(name, counter);
    }
    counter.add(value, sanitizeTelemetryAttributes(attributes));
  } catch {
    // Telemetry must never affect the reporting path.
  }
}

export function recordTelemetryHistogram(
  name: string,
  value: number,
  attributes: Record<string, unknown> = {},
  unit = "ms"
): void {
  if (!Number.isFinite(value) || value < 0) return;
  try {
    let histogram = histograms.get(name);
    if (!histogram) {
      histogram = meter.createHistogram(name, { unit });
      histograms.set(name, histogram);
    }
    histogram.record(value, sanitizeTelemetryAttributes(attributes));
  } catch {
    // Telemetry must never affect the reporting path.
  }
}

function createSdk(config: TelemetryConfig): NodeSDK {
  return new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: config.serviceName,
      [ATTR_SERVICE_VERSION]: config.serviceVersion
    }),
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(config.samplingRatio)
    }),
    traceExporter: new OTLPTraceExporter({ url: config.tracesEndpoint }),
    metricReaders: [new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: config.metricsEndpoint }),
      exportIntervalMillis: config.metricExportIntervalMs
    })]
  });
}

function sanitizeAttributeValue(value: unknown): AttributeValue | undefined {
  if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
  if (typeof value === "string") return value.slice(0, MAX_ATTRIBUTE_LENGTH);
  if (Array.isArray(value)) {
    const strings = value
      .filter((item): item is string => typeof item === "string")
      .slice(0, 20)
      .map((item) => item.slice(0, MAX_ATTRIBUTE_LENGTH));
    return strings.length > 0 ? strings : undefined;
  }
  return undefined;
}

function boundedErrorType(error: unknown): string {
  if (error instanceof Error && error.name) return error.name.slice(0, 80);
  return "Error";
}

function noOpHandle(config: TelemetryConfig): TelemetryHandle {
  return {
    enabled: false,
    config,
    shutdown: async () => undefined
  };
}
