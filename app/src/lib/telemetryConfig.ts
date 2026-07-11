export interface TelemetryConfig {
  enabled: boolean;
  serviceName: string;
  serviceVersion: string;
  tracesEndpoint: string;
  metricsEndpoint: string;
  samplingRatio: number;
  metricExportIntervalMs: number;
}

export interface TelemetryConfigResult {
  config: TelemetryConfig;
  warnings: string[];
}

const DEFAULT_OTLP_ENDPOINT = "http://localhost:4318";

export function loadTelemetryConfig(
  env: NodeJS.ProcessEnv = process.env
): TelemetryConfigResult {
  const warnings: string[] = [];
  const enabled = parseBoolean(env.OTEL_ENABLED, false, "OTEL_ENABLED", warnings);
  const baseEndpoint = validEndpoint(
    env.OTEL_EXPORTER_OTLP_ENDPOINT || DEFAULT_OTLP_ENDPOINT,
    DEFAULT_OTLP_ENDPOINT,
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    warnings
  );
  const config: TelemetryConfig = {
    enabled,
    serviceName: boundedLabel(env.OTEL_SERVICE_NAME, "report-pilot", 255, "OTEL_SERVICE_NAME", warnings),
    serviceVersion: boundedLabel(env.OTEL_SERVICE_VERSION, "0.1.0", 64, "OTEL_SERVICE_VERSION", warnings),
    tracesEndpoint: validEndpoint(
      env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || signalEndpoint(baseEndpoint, "traces"),
      signalEndpoint(DEFAULT_OTLP_ENDPOINT, "traces"),
      "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
      warnings
    ),
    metricsEndpoint: validEndpoint(
      env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT || signalEndpoint(baseEndpoint, "metrics"),
      signalEndpoint(DEFAULT_OTLP_ENDPOINT, "metrics"),
      "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
      warnings
    ),
    samplingRatio: boundedNumber(env.OTEL_TRACES_SAMPLER_ARG, 1, 0, 1, "OTEL_TRACES_SAMPLER_ARG", warnings),
    metricExportIntervalMs: boundedNumber(
      env.OTEL_METRIC_EXPORT_INTERVAL,
      60_000,
      1_000,
      3_600_000,
      "OTEL_METRIC_EXPORT_INTERVAL",
      warnings
    )
  };
  return { config: { ...config, enabled: enabled && warnings.length === 0 }, warnings };
}

function parseBoolean(
  value: string | undefined,
  fallback: boolean,
  key: string,
  warnings: string[]
): boolean {
  if (value === undefined || value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  warnings.push(`${key} must be true or false; telemetry was disabled`);
  return false;
}

function validEndpoint(
  value: string,
  fallback: string,
  key: string,
  warnings: string[]
): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
    return url.toString().replace(/\/$/, "");
  } catch {
    warnings.push(`${key} must be an http(s) URL; telemetry was disabled`);
    return fallback;
  }
}

function signalEndpoint(baseEndpoint: string, signal: "traces" | "metrics"): string {
  return `${baseEndpoint.replace(/\/$/, "")}/v1/${signal}`;
}

function boundedLabel(
  value: string | undefined,
  fallback: string,
  maxLength: number,
  key: string,
  warnings: string[]
): string {
  const normalized = String(value || fallback).trim();
  if (!normalized || normalized.length > maxLength) {
    warnings.push(`${key} must contain 1-${maxLength} characters; telemetry was disabled`);
    return fallback;
  }
  return normalized;
}

function boundedNumber(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  key: string,
  warnings: string[]
): number {
  if (value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    warnings.push(`${key} must be between ${minimum} and ${maximum}; telemetry was disabled`);
    return fallback;
  }
  return number;
}
