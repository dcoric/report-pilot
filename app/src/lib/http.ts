import type { IncomingMessage, ServerResponse } from "http";

export interface HttpError extends Error {
  statusCode?: number;
}

export function json(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

export function notFound(res: ServerResponse): void {
  return json(res, 404, { error: "not_found" });
}

export function badRequest(res: ServerResponse, message?: string): void {
  return json(res, 400, { error: "bad_request", message });
}

export function internalError(res: ServerResponse, message: string = "internal_server_error"): void {
  return json(res, 500, { error: "internal_error", message });
}

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("Invalid JSON body") as HttpError;
    error.statusCode = 400;
    throw error;
  }
}
