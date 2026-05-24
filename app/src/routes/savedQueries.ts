import type { ServerResponse } from "http";
import type { URL } from "url";
import type { AuthedRequest } from "../lib/authGate";
import appDb = require("../lib/appDb");
import { json, readJsonBody } from "../lib/http";
import { isUuid } from "../lib/validation";
import {
  createSavedQuery,
  listSavedQueries,
  getSavedQuery,
  updateSavedQuery,
  deleteSavedQuery,
  validateSavedQueryParams,
  executeSavedQuery,
  shareSavedQuery,
  getSavedQueryAccess,
  listSavedQueryVersions,
  restoreSavedQueryVersion
} from "../services/savedQueryService";
import { writeEvent } from "../services/auditService";
import { enforceDataSourceAccess, listAccessibleDataSourceIds } from "../lib/authGate";

function callerId(req: AuthedRequest): string | null {
  return (req.user && req.user.id) || null;
}

function requestClientIp(req: AuthedRequest): string | null {
  return (req.socket && req.socket.remoteAddress) || null;
}

function writeResult(res: ServerResponse, result: { statusCode: number; body: unknown }): void {
  return json(res, result.statusCode, result.body);
}

async function loadSavedQueryDataSourceId(savedQueryId: string): Promise<string | null> {
  if (!isUuid(savedQueryId)) return null;
  const result = await appDb.query(
    "SELECT data_source_id FROM saved_queries WHERE id = $1",
    [savedQueryId]
  );
  return result.rowCount > 0 ? result.rows[0].data_source_id : null;
}

async function dataSourceExists(dataSourceId: string): Promise<boolean> {
  if (!isUuid(dataSourceId)) return false;
  const result = await appDb.query("SELECT id FROM data_sources WHERE id = $1", [dataSourceId]);
  return result.rowCount > 0;
}

async function handleCreateSavedQuery(req: AuthedRequest, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req) as Record<string, unknown>;
  if (body && body.data_source_id && await dataSourceExists(body.data_source_id as string)) {
    if (!(await enforceDataSourceAccess(req, res, body.data_source_id as string))) {
      return undefined;
    }
  }
  const result = await createSavedQuery({
    ownerId: callerId(req),
    name: body.name,
    description: body.description,
    dataSourceId: body.data_source_id,
    sql: body.sql,
    defaultRunParams: body.default_run_params,
    parameterSchema: body.parameter_schema,
    tags: body.tags,
    visibility: body.visibility
  });
  return writeResult(res, result);
}

async function handleListSavedQueries(req: AuthedRequest, res: ServerResponse, requestUrl: URL): Promise<void> {
  const dataSourceId = requestUrl.searchParams.get("data_source_id");
  if (dataSourceId && isUuid(dataSourceId) && !(await enforceDataSourceAccess(req, res, dataSourceId))) {
    return undefined;
  }
  const accessible = await listAccessibleDataSourceIds(req);
  const result = await listSavedQueries(
    dataSourceId,
    requestUrl.searchParams.get("tag"),
    { callerUserId: callerId(req) }
  );
  if (accessible !== null && result.ok && Array.isArray(result.body.items)) {
    const accessibleSet = new Set(accessible);
    result.body.items = result.body.items.filter((item) => accessibleSet.has(item.data_source_id));
  }
  return writeResult(res, result);
}

async function handleGetSavedQuery(req: AuthedRequest, res: ServerResponse, savedQueryId: string): Promise<void> {
  const dsId = await loadSavedQueryDataSourceId(savedQueryId);
  if (dsId && !(await enforceDataSourceAccess(req, res, dsId))) {
    return undefined;
  }
  const result = await getSavedQuery(savedQueryId, { callerUserId: callerId(req) });
  return writeResult(res, result);
}

async function handleUpdateSavedQuery(req: AuthedRequest, res: ServerResponse, savedQueryId: string): Promise<void> {
  const dsId = await loadSavedQueryDataSourceId(savedQueryId);
  if (dsId && !(await enforceDataSourceAccess(req, res, dsId))) {
    return undefined;
  }
  const body = await readJsonBody(req) as Record<string, unknown>;
  if (body && body.data_source_id && body.data_source_id !== dsId
      && await dataSourceExists(body.data_source_id as string)) {
    if (!(await enforceDataSourceAccess(req, res, body.data_source_id as string))) {
      return undefined;
    }
  }
  const result = await updateSavedQuery(savedQueryId, {
    name: body.name,
    description: body.description,
    dataSourceId: body.data_source_id,
    sql: body.sql,
    defaultRunParams: body.default_run_params,
    parameterSchema: body.parameter_schema,
    tags: body.tags,
    visibility: body.visibility,
    callerUserId: callerId(req)
  });
  return writeResult(res, result);
}

async function handleDeleteSavedQuery(req: AuthedRequest, res: ServerResponse, savedQueryId: string): Promise<void> {
  const dsId = await loadSavedQueryDataSourceId(savedQueryId);
  if (dsId && !(await enforceDataSourceAccess(req, res, dsId))) {
    return undefined;
  }
  const result = await deleteSavedQuery(savedQueryId, { callerUserId: callerId(req) });
  return writeResult(res, result);
}

async function handleValidateParams(req: AuthedRequest, res: ServerResponse, savedQueryId: string): Promise<void> {
  const dsId = await loadSavedQueryDataSourceId(savedQueryId);
  if (dsId && !(await enforceDataSourceAccess(req, res, dsId))) {
    return undefined;
  }
  const body = await readJsonBody(req) as Record<string, unknown>;
  const result = await validateSavedQueryParams(savedQueryId, body.params, {
    callerUserId: callerId(req)
  });
  return writeResult(res, result);
}

async function handleRunSavedQuery(req: AuthedRequest, res: ServerResponse, savedQueryId: string): Promise<void> {
  const dsId = await loadSavedQueryDataSourceId(savedQueryId);
  if (dsId && !(await enforceDataSourceAccess(req, res, dsId))) {
    return undefined;
  }
  const body = await readJsonBody(req) as Record<string, unknown>;
  const result = await executeSavedQuery(savedQueryId, {
    params: body.params,
    maxRows: body.max_rows,
    timeoutMs: body.timeout_ms,
    callerUserId: callerId(req)
  });
  return writeResult(res, result);
}

async function handleShareSavedQuery(req: AuthedRequest, res: ServerResponse, savedQueryId: string): Promise<void> {
  const dsId = await loadSavedQueryDataSourceId(savedQueryId);
  if (dsId && !(await enforceDataSourceAccess(req, res, dsId))) {
    return undefined;
  }
  const body = await readJsonBody(req) as Record<string, unknown>;
  const result = await shareSavedQuery(savedQueryId, {
    callerUserId: callerId(req),
    visibility: body.visibility,
    shares: body.shares
  });

  if (result.ok) {
    const actor = callerId(req);
    const summary = result.body as {
      previous_visibility: string;
      visibility: string;
      diff: {
        added: Array<{ user_id: string; permission: string }>;
        updated: Array<{ user_id: string; previous_permission: string; permission: string }>;
        removed: Array<{ user_id: string; permission: string }>;
      };
    };
    const ip = requestClientIp(req);
    const userAgent = req.headers["user-agent"] || null;
    if (summary.previous_visibility !== summary.visibility) {
      writeEvent({
        actorUserId: actor,
        action: "saved_query.visibility.changed",
        details: {
          saved_query_id: savedQueryId,
          previous: summary.previous_visibility,
          next: summary.visibility
        },
        ipAddress: ip,
        userAgent
      }).catch(() => {});
    }
    for (const entry of summary.diff.added) {
      writeEvent({
        actorUserId: actor,
        targetUserId: entry.user_id,
        action: "saved_query.share.granted",
        details: { saved_query_id: savedQueryId, permission: entry.permission },
        ipAddress: ip,
        userAgent
      }).catch(() => {});
    }
    for (const entry of summary.diff.updated) {
      writeEvent({
        actorUserId: actor,
        targetUserId: entry.user_id,
        action: "saved_query.share.updated",
        details: {
          saved_query_id: savedQueryId,
          previous_permission: entry.previous_permission,
          permission: entry.permission
        },
        ipAddress: ip,
        userAgent
      }).catch(() => {});
    }
    for (const entry of summary.diff.removed) {
      writeEvent({
        actorUserId: actor,
        targetUserId: entry.user_id,
        action: "saved_query.share.revoked",
        details: { saved_query_id: savedQueryId, permission: entry.permission },
        ipAddress: ip,
        userAgent
      }).catch(() => {});
    }
  }

  return writeResult(res, result);
}

async function handleGetSavedQueryAccess(req: AuthedRequest, res: ServerResponse, savedQueryId: string): Promise<void> {
  const dsId = await loadSavedQueryDataSourceId(savedQueryId);
  if (dsId && !(await enforceDataSourceAccess(req, res, dsId))) {
    return undefined;
  }
  const result = await getSavedQueryAccess(savedQueryId, {
    callerUserId: callerId(req)
  });
  return writeResult(res, result);
}

async function handleListSavedQueryVersions(req: AuthedRequest, res: ServerResponse, savedQueryId: string): Promise<void> {
  const dsId = await loadSavedQueryDataSourceId(savedQueryId);
  if (dsId && !(await enforceDataSourceAccess(req, res, dsId))) {
    return undefined;
  }
  const result = await listSavedQueryVersions(savedQueryId, {
    callerUserId: callerId(req)
  });
  return writeResult(res, result);
}

async function handleRestoreSavedQueryVersion(req: AuthedRequest, res: ServerResponse, savedQueryId: string, versionId: string): Promise<void> {
  const dsId = await loadSavedQueryDataSourceId(savedQueryId);
  if (dsId && !(await enforceDataSourceAccess(req, res, dsId))) {
    return undefined;
  }
  const result = await restoreSavedQueryVersion(savedQueryId, versionId, {
    callerUserId: callerId(req)
  });

  if (result.ok) {
    writeEvent({
      actorUserId: callerId(req),
      action: "saved_query.version.restored",
      details: {
        saved_query_id: savedQueryId,
        restored_from_version_number: (result.body as { restored_from_version_number: number }).restored_from_version_number,
        new_version_number: (result.body as { new_version: { version_number: number } }).new_version.version_number
      },
      ipAddress: requestClientIp(req),
      userAgent: req.headers["user-agent"] || null
    }).catch(() => {});
  }

  return writeResult(res, result);
}

export {
  handleCreateSavedQuery,
  handleListSavedQueries,
  handleGetSavedQuery,
  handleUpdateSavedQuery,
  handleDeleteSavedQuery,
  handleValidateParams,
  handleRunSavedQuery,
  handleShareSavedQuery,
  handleGetSavedQueryAccess,
  handleListSavedQueryVersions,
  handleRestoreSavedQueryVersion
};
