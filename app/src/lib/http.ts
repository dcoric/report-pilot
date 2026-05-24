import type { IncomingMessage, ServerResponse } from "http";
import type { URL } from "url";
import type { AuthedRequest } from "./authGate";

export interface HttpError extends Error {
  statusCode?: number;
}

/**
 * A handler that just takes the (req, res) pair — the common case for routes
 * that don't depend on a path id or query string.
 *
 * `TBody` and `TResp` are documentation-grade type parameters: they describe
 * the JSON request body and response shape the handler is meant to deal with,
 * but TypeScript can't enforce them across the dispatcher boundary in
 * `server.js`. Use them by passing the matching OpenAPI schema, e.g.
 * `RouteHandler<LoginRequest, AuthMeResponse>`.
 */
export type RouteHandler<TBody = unknown, TResp = unknown> = (
  req: AuthedRequest,
  res: ServerResponse
) => Promise<void>;

/** Handler variant for routes whose path captures a single id. */
export type RouteHandlerWithId<TBody = unknown, TResp = unknown> = (
  req: AuthedRequest,
  res: ServerResponse,
  id: string
) => Promise<void>;

/** Handler variant for nested resources that capture two ids. */
export type RouteHandlerWithIds<TBody = unknown, TResp = unknown> = (
  req: AuthedRequest,
  res: ServerResponse,
  idA: string,
  idB: string
) => Promise<void>;

/** Handler variant for routes that receive the parsed request URL. */
export type RouteHandlerWithUrl<TBody = unknown, TResp = unknown> = (
  req: AuthedRequest,
  res: ServerResponse,
  requestUrl: URL
) => Promise<void>;

/** Shape returned by typed services in `app/src/services/*`. */
export interface ServiceResult<TBody = unknown> {
  statusCode: number;
  body: TBody;
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

/** Forward a service result (`{statusCode, body}`) to the HTTP response. */
export function writeServiceResult(res: ServerResponse, result: ServiceResult): void {
  return json(res, result.statusCode, result.body);
}

/**
 * Read a JSON body from the request. The optional type parameter is an
 * unchecked assertion of the inbound JSON shape — the caller takes
 * responsibility for runtime validation (services on this codebase already
 * validate every field they consume, so the unchecked cast is intentional).
 * Defaults to `unknown` to keep raw callers honest.
 */
export async function readJsonBody<T = unknown>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {} as T;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    const error = new Error("Invalid JSON body") as HttpError;
    error.statusCode = 400;
    throw error;
  }
}

/** True for an Error-shaped value. Convenient inside catch blocks. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message: unknown }).message;
    return typeof m === "string" ? m : String(m);
  }
  return String(err);
}
