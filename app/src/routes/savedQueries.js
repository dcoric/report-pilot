const appDb = require("../lib/appDb");
const { json, readJsonBody } = require("../lib/http");
const { isUuid } = require("../lib/validation");
const savedQueryService = require("../services/savedQueryService");
const { enforceDataSourceAccess, listAccessibleDataSourceIds } = require("../lib/authGate");

function writeResult(res, result) {
  return json(res, result.statusCode, result.body);
}

async function loadSavedQueryDataSourceId(savedQueryId) {
  if (!isUuid(savedQueryId)) return null;
  const result = await appDb.query(
    "SELECT data_source_id FROM saved_queries WHERE id = $1",
    [savedQueryId]
  );
  return result.rowCount > 0 ? result.rows[0].data_source_id : null;
}

async function dataSourceExists(dataSourceId) {
  if (!isUuid(dataSourceId)) return false;
  const result = await appDb.query("SELECT id FROM data_sources WHERE id = $1", [dataSourceId]);
  return result.rowCount > 0;
}

async function handleCreateSavedQuery(req, res) {
  const body = await readJsonBody(req);
  if (body && body.data_source_id && await dataSourceExists(body.data_source_id)) {
    if (!(await enforceDataSourceAccess(req, res, body.data_source_id))) {
      return undefined;
    }
  }
  const result = await savedQueryService.createSavedQuery({
    ownerId: req.user && req.user.id ? req.user.id : null,
    name: body.name,
    description: body.description,
    dataSourceId: body.data_source_id,
    sql: body.sql,
    defaultRunParams: body.default_run_params,
    parameterSchema: body.parameter_schema,
    tags: body.tags
  });
  return writeResult(res, result);
}

async function handleListSavedQueries(req, res, requestUrl) {
  const dataSourceId = requestUrl.searchParams.get("data_source_id");
  if (dataSourceId && isUuid(dataSourceId) && !(await enforceDataSourceAccess(req, res, dataSourceId))) {
    return undefined;
  }
  const accessible = await listAccessibleDataSourceIds(req);
  const result = await savedQueryService.listSavedQueries(
    dataSourceId,
    requestUrl.searchParams.get("tag")
  );
  if (accessible !== null && Array.isArray(result.body && result.body.items)) {
    const accessibleSet = new Set(accessible);
    result.body = {
      ...result.body,
      items: result.body.items.filter((item) => accessibleSet.has(item.data_source_id))
    };
  }
  return writeResult(res, result);
}

async function handleGetSavedQuery(req, res, savedQueryId) {
  const dsId = await loadSavedQueryDataSourceId(savedQueryId);
  if (dsId && !(await enforceDataSourceAccess(req, res, dsId))) {
    return undefined;
  }
  const result = await savedQueryService.getSavedQuery(savedQueryId);
  return writeResult(res, result);
}

async function handleUpdateSavedQuery(req, res, savedQueryId) {
  const dsId = await loadSavedQueryDataSourceId(savedQueryId);
  if (dsId && !(await enforceDataSourceAccess(req, res, dsId))) {
    return undefined;
  }
  const body = await readJsonBody(req);
  if (body && body.data_source_id && body.data_source_id !== dsId
      && await dataSourceExists(body.data_source_id)) {
    if (!(await enforceDataSourceAccess(req, res, body.data_source_id))) {
      return undefined;
    }
  }
  const result = await savedQueryService.updateSavedQuery(savedQueryId, {
    name: body.name,
    description: body.description,
    dataSourceId: body.data_source_id,
    sql: body.sql,
    defaultRunParams: body.default_run_params,
    parameterSchema: body.parameter_schema,
    tags: body.tags
  });
  return writeResult(res, result);
}

async function handleDeleteSavedQuery(req, res, savedQueryId) {
  const dsId = await loadSavedQueryDataSourceId(savedQueryId);
  if (dsId && !(await enforceDataSourceAccess(req, res, dsId))) {
    return undefined;
  }
  const result = await savedQueryService.deleteSavedQuery(savedQueryId);
  return writeResult(res, result);
}

async function handleValidateParams(req, res, savedQueryId) {
  const dsId = await loadSavedQueryDataSourceId(savedQueryId);
  if (dsId && !(await enforceDataSourceAccess(req, res, dsId))) {
    return undefined;
  }
  const body = await readJsonBody(req);
  const result = await savedQueryService.validateSavedQueryParams(savedQueryId, body.params);
  return writeResult(res, result);
}

async function handleRunSavedQuery(req, res, savedQueryId) {
  const dsId = await loadSavedQueryDataSourceId(savedQueryId);
  if (dsId && !(await enforceDataSourceAccess(req, res, dsId))) {
    return undefined;
  }
  const body = await readJsonBody(req);
  const result = await savedQueryService.executeSavedQuery(savedQueryId, {
    params: body.params,
    maxRows: body.max_rows,
    timeoutMs: body.timeout_ms
  });
  return writeResult(res, result);
}

module.exports = {
  handleCreateSavedQuery,
  handleListSavedQueries,
  handleGetSavedQuery,
  handleUpdateSavedQuery,
  handleDeleteSavedQuery,
  handleValidateParams,
  handleRunSavedQuery
};
