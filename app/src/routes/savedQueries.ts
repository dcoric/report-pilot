import appDb = require("../lib/appDb");
import {
  json,
  readJsonBody,
  writeServiceResult,
  type RouteHandler,
  type RouteHandlerWithId,
  type RouteHandlerWithIds,
  type RouteHandlerWithUrl
} from "../lib/http";
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
import { enforceDataSourceAccess, listAccessibleDataSourceIds, type AuthedRequest } from "../lib/authGate";
import type {
  CreateSavedQueryRequest,
  UpdateSavedQueryRequest,
  ShareSavedQueryRequest,
  ValidateParamsRequest,
  RunSavedQueryRequest
} from "../types";

function callerId(req: AuthedRequest): string | null {
  return (req.user && req.user.id) || null;
}

function requestClientIp(req: AuthedRequest): string | null {
  return (req.socket && req.socket.remoteAddress) || null;
}

async function loadSavedQueryDataSourceId(savedQueryId: string): Promise<string | null> {
  if (!isUuid(savedQueryId)) return null;
  const result = await appDb.query<{ data_source_id: string }>(
    "SELECT data_source_id FROM saved_queries WHERE id = $1",
    [savedQueryId]
  );
  return (result.rowCount ?? 0) > 0 ? result.rows[0].data_source_id : null;
}

async function dataSourceExists(dataSourceId: string): Promise<boolean> {
  if (!isUuid(dataSourceId)) return false;
  const result = await appDb.query("SELECT id FROM data_sources WHERE id = $1", [dataSourceId]);
  return (result.rowCount ?? 0) > 0;
}

const handleCreateSavedQuery: RouteHandler<CreateSavedQueryRequest> = async (req, res) => {
  const body = await readJsonBody<Partial<CreateSavedQueryRequest>>(req);
  if (body && body.data_source_id && await dataSourceExists(body.data_source_id)) {
    if (!(await enforceDataSourceAccess(req, res, body.data_source_id))) {
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
  return writeServiceResult(res, result);
};

const handleListSavedQueries: RouteHandlerWithUrl = async (req, res, requestUrl) => {
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
  if (result.ok && accessible !== null) {
    const accessibleSet = new Set(accessible);
    const filteredItems = result.body.items.filter((item) => accessibleSet.has(item.data_source_id));
    return json(res, result.statusCode, { ...result.body, items: filteredItems });
  }
  return writeServiceResult(res, result);
};

const handleGetSavedQuery: RouteHandlerWithId = async (req, res, savedQueryId) => {
  const dsId = await loadSavedQueryDataSourceId(savedQueryId);
  if (dsId && !(await enforceDataSourceAccess(req, res, dsId))) {
    return undefined;
  }
  const result = await getSavedQuery(savedQueryId, { callerUserId: callerId(req) });
  return writeServiceResult(res, result);
};

const handleUpdateSavedQuery: RouteHandlerWithId<UpdateSavedQueryRequest> = async (req, res, savedQueryId) => {
  const dsId = await loadSavedQueryDataSourceId(savedQueryId);
  if (dsId && !(await enforceDataSourceAccess(req, res, dsId))) {
    return undefined;
  }
  const body = await readJsonBody<Partial<UpdateSavedQueryRequest>>(req);
  if (body && body.data_source_id && body.data_source_id !== dsId
      && await dataSourceExists(body.data_source_id)) {
    if (!(await enforceDataSourceAccess(req, res, body.data_source_id))) {
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
  return writeServiceResult(res, result);
};

const handleDeleteSavedQuery: RouteHandlerWithId = async (req, res, savedQueryId) => {
  const dsId = await loadSavedQueryDataSourceId(savedQueryId);
  if (dsId && !(await enforceDataSourceAccess(req, res, dsId))) {
    return undefined;
  }
  const result = await deleteSavedQuery(savedQueryId, { callerUserId: callerId(req) });
  return writeServiceResult(res, result);
};

const handleValidateParams: RouteHandlerWithId<ValidateParamsRequest> = async (req, res, savedQueryId) => {
  const dsId = await loadSavedQueryDataSourceId(savedQueryId);
  if (dsId && !(await enforceDataSourceAccess(req, res, dsId))) {
    return undefined;
  }
  const body = await readJsonBody<Partial<ValidateParamsRequest>>(req);
  const result = await validateSavedQueryParams(savedQueryId, body.params, {
    callerUserId: callerId(req)
  });
  return writeServiceResult(res, result);
};

const handleRunSavedQuery: RouteHandlerWithId<RunSavedQueryRequest> = async (req, res, savedQueryId) => {
  const dsId = await loadSavedQueryDataSourceId(savedQueryId);
  if (dsId && !(await enforceDataSourceAccess(req, res, dsId))) {
    return undefined;
  }
  const body = await readJsonBody<Partial<RunSavedQueryRequest>>(req);
  const result = await executeSavedQuery(savedQueryId, {
    params: body.params,
    maxRows: body.max_rows,
    timeoutMs: body.timeout_ms,
    callerUserId: callerId(req)
  });
  return writeServiceResult(res, result);
};

const handleShareSavedQuery: RouteHandlerWithId<ShareSavedQueryRequest> = async (req, res, savedQueryId) => {
  const dsId = await loadSavedQueryDataSourceId(savedQueryId);
  if (dsId && !(await enforceDataSourceAccess(req, res, dsId))) {
    return undefined;
  }
  const body = await readJsonBody<Partial<ShareSavedQueryRequest>>(req);
  const result = await shareSavedQuery(savedQueryId, {
    callerUserId: callerId(req),
    visibility: body.visibility,
    shares: body.shares
  });

  // Narrow the discriminated union so we can read the typed diff directly.
  if (result.ok) {
    const summary = result.body;
    const actor = callerId(req);
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

  return writeServiceResult(res, result);
};

const handleGetSavedQueryAccess: RouteHandlerWithId = async (req, res, savedQueryId) => {
  const dsId = await loadSavedQueryDataSourceId(savedQueryId);
  if (dsId && !(await enforceDataSourceAccess(req, res, dsId))) {
    return undefined;
  }
  const result = await getSavedQueryAccess(savedQueryId, {
    callerUserId: callerId(req)
  });
  return writeServiceResult(res, result);
};

const handleListSavedQueryVersions: RouteHandlerWithId = async (req, res, savedQueryId) => {
  const dsId = await loadSavedQueryDataSourceId(savedQueryId);
  if (dsId && !(await enforceDataSourceAccess(req, res, dsId))) {
    return undefined;
  }
  const result = await listSavedQueryVersions(savedQueryId, {
    callerUserId: callerId(req)
  });
  return writeServiceResult(res, result);
};

const handleRestoreSavedQueryVersion: RouteHandlerWithIds = async (req, res, savedQueryId, versionId) => {
  const dsId = await loadSavedQueryDataSourceId(savedQueryId);
  if (dsId && !(await enforceDataSourceAccess(req, res, dsId))) {
    return undefined;
  }
  const result = await restoreSavedQueryVersion(savedQueryId, versionId, {
    callerUserId: callerId(req)
  });

  // Narrow to access typed `restored_from_version_number` / `new_version`.
  if (result.ok) {
    writeEvent({
      actorUserId: callerId(req),
      action: "saved_query.version.restored",
      details: {
        saved_query_id: savedQueryId,
        restored_from_version_number: result.body.restored_from_version_number,
        new_version_number: result.body.new_version.version_number
      },
      ipAddress: requestClientIp(req),
      userAgent: req.headers["user-agent"] || null
    }).catch(() => {});
  }

  return writeServiceResult(res, result);
};

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
