import appDb = require("../lib/appDb");
import { json, badRequest, readJsonBody } from "../lib/http";
import { isUuid } from "../lib/validation";
import ragService = require("../services/ragService");
import { enforceDataSourceAccess } from "../lib/authGate";
import type { ServerResponse } from "http";
import type { URL } from "url";
import type { AuthedRequest } from "../lib/authGate";

async function handleListSchemaObjects(req: AuthedRequest, res: ServerResponse, requestUrl: URL): Promise<void> {
  const dataSourceId = requestUrl.searchParams.get("data_source_id");
  if (!dataSourceId) {
    return badRequest(res, "data_source_id query parameter is required");
  }

  if (!(await enforceDataSourceAccess(req, res, dataSourceId))) {
    return undefined;
  }

  const result = await appDb.query(
    `
      SELECT id, object_type, schema_name, object_name, description, is_ignored
      FROM schema_objects
      WHERE data_source_id = $1
      ORDER BY schema_name, object_name
    `,
    [dataSourceId]
  );

  return json(res, 200, { items: result.rows });
}

async function handlePatchSchemaObject(req: AuthedRequest, res: ServerResponse, schemaObjectId: string): Promise<void> {
  if (!isUuid(schemaObjectId)) {
    return badRequest(res, "schemaObjectId must be a valid UUID");
  }

  const objLookup = await appDb.query(
    "SELECT data_source_id FROM schema_objects WHERE id = $1",
    [schemaObjectId]
  );
  if (objLookup.rowCount === 0) {
    return json(res, 404, { error: "not_found", message: "Schema object not found" });
  }
  if (!(await enforceDataSourceAccess(req, res, objLookup.rows[0].data_source_id))) {
    return undefined;
  }

  const body = await readJsonBody(req) as any;
  if (!Object.prototype.hasOwnProperty.call(body, "is_ignored")) {
    return badRequest(res, "is_ignored is required");
  }
  if (typeof body.is_ignored !== "boolean") {
    return badRequest(res, "is_ignored must be a boolean");
  }

  const result = await appDb.query(
    `
      UPDATE schema_objects
      SET is_ignored = $2
      WHERE id = $1
      RETURNING
        id,
        data_source_id,
        object_type,
        schema_name,
        object_name,
        description,
        is_ignored
    `,
    [schemaObjectId, body.is_ignored]
  );

  if (result.rowCount === 0) {
    return json(res, 404, { error: "not_found", message: "Schema object not found" });
  }

  ragService.triggerRagReindexAsync(result.rows[0].data_source_id);

  return json(res, 200, result.rows[0]);
}

export {
  handleListSchemaObjects,
  handlePatchSchemaObject
};
