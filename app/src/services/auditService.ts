// AUTH-008: shared audit-log writer and reader.
//
// Writers (services that mutate auth/permission state) call `writeEvent`. The
// reader (`listEvents`) is used by GET /v1/admin/audit-events.
//
// The `client` argument is optional: pass a transaction client when the audit
// write must commit/rollback with surrounding work (role assignment, data
// source access grants). For standalone events (login, auth provider CRUD)
// the function falls back to `appDb`.

import type { PoolClient } from "pg";
import appDb = require("../lib/appDb");

export type AuditOutcome = "success" | "failure" | "info";

export interface WriteEventInput {
  actorUserId?: string | null;
  actorEmail?: string | null;
  targetUserId?: string | null;
  action: string;
  outcome?: AuditOutcome | string;
  details?: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface ListEventsInput {
  action?: string | null;
  actorUserId?: string | null;
  targetUserId?: string | null;
  outcome?: string | null;
  since?: string | null;
  until?: string | null;
  limit?: number;
  offset?: number;
}

export interface AuditEventItem {
  id: string;
  actor_user_id: string | null;
  actor_email: string | null;
  actor: { id: string; email: string | null; display_name: string | null } | null;
  target_user_id: string | null;
  target: { id: string; email: string | null; display_name: string | null } | null;
  action: string;
  outcome: AuditOutcome | string | null;
  details: Record<string, unknown>;
  ip_address: string | null;
  user_agent: string | null;
  created_at: Date | string;
}

export interface ListEventsResult {
  items: AuditEventItem[];
  total: number;
  limit: number;
  offset: number;
}

const ALLOWED_OUTCOMES: ReadonlySet<string> = new Set(["success", "failure", "info"]);

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

function trimString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function normalizeOutcome(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return null;
  const lower = value.trim().toLowerCase();
  return ALLOWED_OUTCOMES.has(lower) ? lower : null;
}

export async function writeEvent(
  {
    actorUserId = null,
    actorEmail = null,
    targetUserId = null,
    action,
    outcome = "success",
    details = {},
    ipAddress = null,
    userAgent = null
  }: WriteEventInput,
  client: PoolClient | null = null
): Promise<void> {
  if (typeof action !== "string" || !action) {
    throw new Error("audit action is required");
  }
  const exec = (client || appDb) as typeof appDb;
  await exec.query(
    `
      INSERT INTO auth_audit_log
        (actor_user_id, actor_email, target_user_id, action, outcome,
         details, ip_address, user_agent)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
    `,
    [
      actorUserId || null,
      trimString(actorEmail, 320),
      targetUserId || null,
      action,
      normalizeOutcome(outcome),
      JSON.stringify(details || {}),
      trimString(ipAddress, 64),
      trimString(userAgent, 1024)
    ]
  );
}

function clampLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(parsed), MAX_LIMIT);
}

function clampOffset(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function parseTimestamp(value: unknown): string | null {
  if (!value) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

interface AuditEventRow {
  id: string;
  actor_user_id: string | null;
  actor_email: string | null;
  target_user_id: string | null;
  action: string;
  outcome: string | null;
  details: Record<string, unknown> | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: Date | string;
  actor_user_email: string | null;
  actor_user_display_name: string | null;
  target_user_email: string | null;
  target_user_display_name: string | null;
}

export async function listEvents({
  action = null,
  actorUserId = null,
  targetUserId = null,
  outcome = null,
  since = null,
  until = null,
  limit = DEFAULT_LIMIT,
  offset = 0
}: ListEventsInput = {}): Promise<ListEventsResult> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (typeof action === "string" && action.trim()) {
    params.push(action.trim());
    conditions.push(`a.action = $${params.length}`);
  }
  if (typeof actorUserId === "string" && actorUserId.trim()) {
    params.push(actorUserId.trim());
    conditions.push(`a.actor_user_id = $${params.length}`);
  }
  if (typeof targetUserId === "string" && targetUserId.trim()) {
    params.push(targetUserId.trim());
    conditions.push(`a.target_user_id = $${params.length}`);
  }
  const outcomeNormalized = normalizeOutcome(outcome);
  if (outcomeNormalized) {
    params.push(outcomeNormalized);
    conditions.push(`a.outcome = $${params.length}`);
  }
  const sinceIso = parseTimestamp(since);
  if (sinceIso) {
    params.push(sinceIso);
    conditions.push(`a.created_at >= $${params.length}`);
  }
  const untilIso = parseTimestamp(until);
  if (untilIso) {
    params.push(untilIso);
    conditions.push(`a.created_at < $${params.length}`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const effectiveLimit = clampLimit(limit);
  const effectiveOffset = clampOffset(offset);

  const countResult = await appDb.query<{ total: string | number }>(
    `SELECT COUNT(*)::bigint AS total FROM auth_audit_log a ${where}`,
    params
  );
  const total = Number(countResult.rows[0] && countResult.rows[0].total) || 0;

  params.push(effectiveLimit);
  params.push(effectiveOffset);
  const listResult = await appDb.query<AuditEventRow>(
    `
      SELECT
        a.id,
        a.actor_user_id,
        a.actor_email,
        a.target_user_id,
        a.action,
        a.outcome,
        a.details,
        a.ip_address,
        a.user_agent,
        a.created_at,
        au.email AS actor_user_email,
        au.display_name AS actor_user_display_name,
        tu.email AS target_user_email,
        tu.display_name AS target_user_display_name
      FROM auth_audit_log a
      LEFT JOIN users au ON au.id = a.actor_user_id
      LEFT JOIN users tu ON tu.id = a.target_user_id
      ${where}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `,
    params
  );

  const items: AuditEventItem[] = listResult.rows.map((row) => ({
    id: row.id,
    actor_user_id: row.actor_user_id,
    actor_email: row.actor_email,
    actor: row.actor_user_id
      ? { id: row.actor_user_id, email: row.actor_user_email, display_name: row.actor_user_display_name }
      : null,
    target_user_id: row.target_user_id,
    target: row.target_user_id
      ? { id: row.target_user_id, email: row.target_user_email, display_name: row.target_user_display_name }
      : null,
    action: row.action,
    outcome: row.outcome,
    details: row.details || {},
    ip_address: row.ip_address,
    user_agent: row.user_agent,
    created_at: row.created_at
  }));

  return {
    items,
    total,
    limit: effectiveLimit,
    offset: effectiveOffset
  };
}
