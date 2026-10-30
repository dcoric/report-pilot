import appDb = require("../lib/appDb");
import { isUuid } from "../lib/validation";
import { loadLatestValidatedSql } from "./queryOrchestrationStore";

export interface CreateQuerySessionInput {
  userId: string;
  dataSourceId: string;
  question: string;
  parentSessionId?: unknown;
}

export type CreateQuerySessionResult =
  | { ok: true; sessionId: string; parentSessionId: string | null }
  | {
    ok: false;
    statusCode: 400 | 404 | 409;
    error: "bad_request" | "not_found" | "refinement_base_unavailable";
    message: string;
  };

/**
 * Creates a query session. When `parentSessionId` is given the new session
 * refines the parent's validated SQL, so the parent must belong to the same
 * user and data source and must have SQL that passed validation. Sessions of
 * other users report not_found so their existence is not revealed.
 */
export async function createQuerySession({
  userId,
  dataSourceId,
  question,
  parentSessionId
}: CreateQuerySessionInput): Promise<CreateQuerySessionResult> {
  let parentId: string | null = null;
  if (parentSessionId !== undefined && parentSessionId !== null) {
    if (!isUuid(parentSessionId)) {
      return { ok: false, statusCode: 400, error: "bad_request", message: "parent_session_id must be a valid UUID" };
    }
    parentId = parentSessionId.toLowerCase();

    const parentResult = await appDb.query<{ user_id: string; data_source_id: string }>(
      "SELECT user_id, data_source_id FROM query_sessions WHERE id = $1",
      [parentId]
    );
    const parent = parentResult.rows[0];
    if (!parent || parent.user_id !== userId) {
      return { ok: false, statusCode: 404, error: "not_found", message: "Parent session not found" };
    }
    if (parent.data_source_id.toLowerCase() !== dataSourceId.toLowerCase()) {
      return {
        ok: false,
        statusCode: 400,
        error: "bad_request",
        message: "parent_session_id belongs to a different data source"
      };
    }
    if (!(await loadLatestValidatedSql(parentId))) {
      return {
        ok: false,
        statusCode: 409,
        error: "refinement_base_unavailable",
        message: "The parent session has no validated SQL to refine"
      };
    }
  }

  const sessionResult = await appDb.query<{ id: string }>(
    `
      INSERT INTO query_sessions (user_id, data_source_id, question, status, parent_session_id)
      VALUES ($1, $2, $3, 'created', $4)
      RETURNING id
    `,
    [userId, dataSourceId, question, parentId]
  );

  return { ok: true, sessionId: sessionResult.rows[0].id, parentSessionId: parentId };
}
