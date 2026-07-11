import type { PoolClient } from "pg";
import appDb = require("../lib/appDb");
import type { QueryClarification } from "./queryClarificationService";

export async function recordPendingClarification(
  sessionId: string,
  clarification: QueryClarification
): Promise<void> {
  await appDb.withTransaction(async (client: PoolClient) => {
    await client.query("SELECT id FROM query_sessions WHERE id = $1 FOR UPDATE", [sessionId]);
    await client.query(
      `
        UPDATE query_clarifications
        SET status = 'superseded'
        WHERE session_id = $1
          AND status = 'pending'
          AND options_json <> $2::jsonb
      `,
      [sessionId, JSON.stringify(clarification)]
    );
    await client.query(
      `
        INSERT INTO query_clarifications (session_id, kind, status, options_json)
        SELECT $1, $2, 'pending', $3::jsonb
        WHERE NOT EXISTS (
          SELECT 1
          FROM query_clarifications
          WHERE session_id = $1
            AND status = 'pending'
            AND options_json = $3::jsonb
        )
      `,
      [sessionId, clarification.kind, JSON.stringify(clarification)]
    );
    await client.query(
      "UPDATE query_sessions SET status = 'awaiting_clarification' WHERE id = $1",
      [sessionId]
    );
  });
}

export async function resolvePendingClarification(
  sessionId: string,
  optionId: string
): Promise<boolean> {
  return appDb.withTransaction(async (client: PoolClient) => {
    const result = await client.query(
      `
        UPDATE query_clarifications
        SET status = 'resolved',
            selected_option_id = $2,
            resolved_at = NOW()
        WHERE id = (
          SELECT id
          FROM query_clarifications
          WHERE session_id = $1
            AND status = 'pending'
            AND options_json @> jsonb_build_object(
              'options',
              jsonb_build_array(jsonb_build_object('id', $2::text))
            )
          ORDER BY created_at DESC
          LIMIT 1
          FOR UPDATE
        )
      `,
      [sessionId, optionId]
    );
    let accepted = (result.rowCount ?? 0) > 0;
    if (!accepted) {
      const existing = await client.query(
        `
          SELECT 1
          FROM query_clarifications
          WHERE session_id = $1
            AND status = 'resolved'
            AND selected_option_id = $2
          ORDER BY resolved_at DESC
          LIMIT 1
        `,
        [sessionId, optionId]
      );
      accepted = (existing.rowCount ?? 0) > 0;
    }
    if (!accepted) return false;
    await client.query("UPDATE query_sessions SET status = 'created' WHERE id = $1", [sessionId]);
    return true;
  });
}

export async function cancelPendingClarification(sessionId: string): Promise<boolean> {
  return appDb.withTransaction(async (client: PoolClient) => {
    const result = await client.query(
      `
        UPDATE query_clarifications
        SET status = 'cancelled'
        WHERE id = (
          SELECT id
          FROM query_clarifications
          WHERE session_id = $1 AND status = 'pending'
          ORDER BY created_at DESC
          LIMIT 1
          FOR UPDATE
        )
      `,
      [sessionId]
    );
    if ((result.rowCount ?? 0) === 0) return false;
    await client.query("UPDATE query_sessions SET status = 'cancelled' WHERE id = $1", [sessionId]);
    return true;
  });
}
