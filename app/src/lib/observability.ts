import * as crypto from "crypto";

export type LogLevel = "info" | "warn" | "error";

export interface LogEventPayload {
  [key: string]: unknown;
}

export function createRequestId(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function logEvent(event: string, data: LogEventPayload = {}, level: LogLevel = "info"): void {
  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    ...data
  };

  const line = JSON.stringify(payload);
  if (level === "error") {
    console.error(line);
    return;
  }
  console.log(line);
}
