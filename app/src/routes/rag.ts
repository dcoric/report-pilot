import appDb = require("../lib/appDb");
import {
  json,
  badRequest,
  readJsonBody,
  type RouteHandler,
  type RouteHandlerWithId,
  type RouteHandlerWithUrl
} from "../lib/http";
import { RAG_NOTE_TITLE_MAX_LENGTH, RAG_NOTE_CONTENT_MAX_LENGTH } from "../lib/constants";
import { isUuid } from "../lib/validation";
import ragService = require("../services/ragService");
import { enforceDataSourceAccess } from "../lib/authGate";
import type { RagNoteRequest } from "../types";

const handleListRagNotes: RouteHandlerWithUrl = async (req, res, requestUrl) => {
  const dataSourceId = String(requestUrl.searchParams.get("data_source_id") || "").trim();
  if (!dataSourceId) {
    return badRequest(res, "data_source_id query parameter is required");
  }
  if (!isUuid(dataSourceId)) {
    return badRequest(res, "data_source_id must be a valid UUID");
  }

  if (!(await enforceDataSourceAccess(req, res, dataSourceId))) {
    return undefined;
  }

  const result = await appDb.query(
    `
      SELECT
        id,
        data_source_id,
        title,
        content,
        active,
        created_at,
        updated_at
      FROM rag_notes
      WHERE data_source_id = $1
      ORDER BY updated_at DESC, created_at DESC
    `,
    [dataSourceId]
  );

  return json(res, 200, { items: result.rows });
};

const handleUpsertRagNote: RouteHandler<RagNoteRequest> = async (req, res) => {
  const body = await readJsonBody<Partial<RagNoteRequest>>(req);
  const id = body.id ? String(body.id).trim() : null;
  const dataSourceId = String(body.data_source_id || "").trim();
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const content = typeof body.content === "string" ? body.content.trim() : "";
  const hasActive = Object.prototype.hasOwnProperty.call(body, "active");
  const active = hasActive && typeof body.active === "boolean" ? body.active : null;

  if (!dataSourceId || !title || !content) {
    return badRequest(res, "data_source_id, title and content are required");
  }
  if (!isUuid(dataSourceId)) {
    return badRequest(res, "data_source_id must be a valid UUID");
  }
  if (id && !isUuid(id)) {
    return badRequest(res, "id must be a valid UUID");
  }
  if (hasActive && typeof body.active !== "boolean") {
    return badRequest(res, "active must be a boolean");
  }
  if (title.length > RAG_NOTE_TITLE_MAX_LENGTH) {
    return badRequest(res, `title cannot exceed ${RAG_NOTE_TITLE_MAX_LENGTH} characters`);
  }
  if (content.length > RAG_NOTE_CONTENT_MAX_LENGTH) {
    return badRequest(res, `content cannot exceed ${RAG_NOTE_CONTENT_MAX_LENGTH} characters`);
  }

  const sourceResult = await appDb.query("SELECT id FROM data_sources WHERE id = $1", [dataSourceId]);
  if (sourceResult.rowCount === 0) {
    return json(res, 404, { error: "not_found", message: "Data source not found" });
  }

  if (!(await enforceDataSourceAccess(req, res, dataSourceId))) {
    return undefined;
  }

  const userId = req.user && req.user.id ? req.user.id : "anonymous";

  if (id) {
    const updateResult = await appDb.query(
      `
        UPDATE rag_notes
        SET
          data_source_id = $2,
          title = $3,
          content = $4,
          active = COALESCE($5, active),
          updated_by = $6,
          updated_at = NOW()
        WHERE id = $1
        RETURNING
          id,
          data_source_id,
          title,
          content,
          active,
          created_at,
          updated_at
      `,
      [id, dataSourceId, title, content, active, userId]
    );

    if (updateResult.rowCount === 0) {
      return json(res, 404, { error: "not_found", message: "RAG note not found" });
    }

    ragService.triggerRagReindexAsync(updateResult.rows[0].data_source_id);
    return json(res, 200, updateResult.rows[0]);
  }

  const insertResult = await appDb.query(
    `
      INSERT INTO rag_notes (
        data_source_id,
        title,
        content,
        active,
        created_by,
        updated_by
      ) VALUES ($1, $2, $3, $4, $5, $5)
      RETURNING
        id,
        data_source_id,
        title,
        content,
        active,
        created_at,
        updated_at
    `,
    [dataSourceId, title, content, active === null ? true : active, userId]
  );

  ragService.triggerRagReindexAsync(dataSourceId);
  return json(res, 200, insertResult.rows[0]);
};

const handleDeleteRagNote: RouteHandlerWithId = async (req, res, noteId) => {
  if (!isUuid(noteId)) {
    return badRequest(res, "noteId must be a valid UUID");
  }

  const noteLookup = await appDb.query(
    "SELECT id, data_source_id FROM rag_notes WHERE id = $1",
    [noteId]
  );
  if (noteLookup.rowCount === 0) {
    return json(res, 404, { error: "not_found", message: "RAG note not found" });
  }

  if (!(await enforceDataSourceAccess(req, res, noteLookup.rows[0].data_source_id))) {
    return undefined;
  }

  const deleteResult = await appDb.query(
    `
      DELETE FROM rag_notes
      WHERE id = $1
      RETURNING id, data_source_id
    `,
    [noteId]
  );

  if (deleteResult.rowCount === 0) {
    return json(res, 404, { error: "not_found", message: "RAG note not found" });
  }

  ragService.triggerRagReindexAsync(deleteResult.rows[0].data_source_id);
  return json(res, 200, { ok: true, id: deleteResult.rows[0].id });
};

const handleRagReindex: RouteHandlerWithUrl = async (req, res, requestUrl) => {
  const dataSourceId = requestUrl.searchParams.get("data_source_id");
  if (!dataSourceId) {
    return badRequest(res, "data_source_id query parameter is required");
  }
  if (!isUuid(dataSourceId)) {
    return badRequest(res, "data_source_id must be a valid UUID");
  }

  const sourceResult = await appDb.query("SELECT id FROM data_sources WHERE id = $1", [dataSourceId]);
  if (sourceResult.rowCount === 0) {
    return json(res, 404, { error: "not_found", message: "Data source not found" });
  }

  if (!(await enforceDataSourceAccess(req, res, dataSourceId))) {
    return undefined;
  }

  const result = await ragService.reindexRagDocuments(dataSourceId);
  return json(res, 202, {
    job_id: "inline-reindex",
    status: "succeeded",
    ...result
  });
};

export {
  handleListRagNotes,
  handleUpsertRagNote,
  handleDeleteRagNote,
  handleRagReindex
};
