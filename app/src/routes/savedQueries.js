const { json, readJsonBody } = require("../lib/http");
const savedQueryService = require("../services/savedQueryService");

function writeResult(res, result) {
  return json(res, result.statusCode, result.body);
}

async function handleCreateSavedQuery(req, res) {
  const body = await readJsonBody(req);
  const result = await savedQueryService.createSavedQuery({
    ownerId: req.headers["x-user-id"],
    name: body.name,
    description: body.description,
    dataSourceId: body.data_source_id,
    sql: body.sql,
    defaultRunParams: body.default_run_params,
    parameterSchema: body.parameter_schema
  });
  return writeResult(res, result);
}

async function handleListSavedQueries(_req, res, requestUrl) {
  const result = await savedQueryService.listSavedQueries(requestUrl.searchParams.get("data_source_id"));
  return writeResult(res, result);
}

async function handleGetSavedQuery(_req, res, savedQueryId) {
  const result = await savedQueryService.getSavedQuery(savedQueryId);
  return writeResult(res, result);
}

async function handleUpdateSavedQuery(req, res, savedQueryId) {
  const body = await readJsonBody(req);
  const result = await savedQueryService.updateSavedQuery(savedQueryId, {
    name: body.name,
    description: body.description,
    dataSourceId: body.data_source_id,
    sql: body.sql,
    defaultRunParams: body.default_run_params,
    parameterSchema: body.parameter_schema
  });
  return writeResult(res, result);
}

async function handleDeleteSavedQuery(_req, res, savedQueryId) {
  const result = await savedQueryService.deleteSavedQuery(savedQueryId);
  return writeResult(res, result);
}

async function handleValidateParams(req, res, savedQueryId) {
  const body = await readJsonBody(req);
  const result = await savedQueryService.validateSavedQueryParams(savedQueryId, body.params);
  return writeResult(res, result);
}

async function handleRunSavedQuery(req, res, savedQueryId) {
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
