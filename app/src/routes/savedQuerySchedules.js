// QUERY-007: routes for managing scheduled saved-query delivery.

const appDb = require("../lib/appDb");
const { json, readJsonBody } = require("../lib/http");
const { isUuid } = require("../lib/validation");
const scheduleService = require("../services/savedQueryScheduleService");
const auditService = require("../services/auditService");
const { enforceDataSourceAccess } = require("../lib/authGate");

function callerId(req) {
  return (req.user && req.user.id) || null;
}

function requestClientIp(req) {
  return (req.socket && req.socket.remoteAddress) || null;
}

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

function emitScheduleAudit(req, action, savedQueryId, details = {}) {
  auditService
    .writeEvent({
      actorUserId: callerId(req),
      action,
      details: { saved_query_id: savedQueryId, ...details },
      ipAddress: requestClientIp(req),
      userAgent: req.headers["user-agent"] || null
    })
    .catch(() => {});
}

async function handleCreateSchedule(req, res, savedQueryId) {
  const dsId = await loadSavedQueryDataSourceId(savedQueryId);
  if (dsId && !(await enforceDataSourceAccess(req, res, dsId))) return undefined;
  const body = await readJsonBody(req);
  const result = await scheduleService.createSchedule(savedQueryId, body, {
    callerUserId: callerId(req)
  });
  if (result.ok) {
    emitScheduleAudit(req, "saved_query.schedule.created", savedQueryId, {
      schedule_id: result.body.id,
      cron_expression: result.body.cron_expression,
      timezone: result.body.timezone,
      delivery_mode: result.body.delivery_mode,
      format: result.body.format,
      recipient_count: (result.body.recipients || []).length
    });
  }
  return writeResult(res, result);
}

async function handleListSchedules(req, res, savedQueryId) {
  const dsId = await loadSavedQueryDataSourceId(savedQueryId);
  if (dsId && !(await enforceDataSourceAccess(req, res, dsId))) return undefined;
  const result = await scheduleService.listSchedules(savedQueryId, {
    callerUserId: callerId(req)
  });
  return writeResult(res, result);
}

async function handleUpdateSchedule(req, res, savedQueryId, scheduleId) {
  const dsId = await loadSavedQueryDataSourceId(savedQueryId);
  if (dsId && !(await enforceDataSourceAccess(req, res, dsId))) return undefined;
  const body = await readJsonBody(req);
  const result = await scheduleService.updateSchedule(savedQueryId, scheduleId, body, {
    callerUserId: callerId(req)
  });
  if (result.ok) {
    emitScheduleAudit(req, "saved_query.schedule.updated", savedQueryId, {
      schedule_id: result.body.id,
      cron_expression: result.body.cron_expression,
      timezone: result.body.timezone,
      delivery_mode: result.body.delivery_mode,
      format: result.body.format,
      status: result.body.status,
      recipient_count: (result.body.recipients || []).length
    });
  }
  return writeResult(res, result);
}

async function handleDeleteSchedule(req, res, savedQueryId, scheduleId) {
  const dsId = await loadSavedQueryDataSourceId(savedQueryId);
  if (dsId && !(await enforceDataSourceAccess(req, res, dsId))) return undefined;
  const result = await scheduleService.deleteSchedule(savedQueryId, scheduleId, {
    callerUserId: callerId(req)
  });
  if (result.ok) {
    emitScheduleAudit(req, "saved_query.schedule.deleted", savedQueryId, {
      schedule_id: scheduleId
    });
  }
  return writeResult(res, result);
}

async function handleRetrySchedule(req, res, savedQueryId, scheduleId) {
  const dsId = await loadSavedQueryDataSourceId(savedQueryId);
  if (dsId && !(await enforceDataSourceAccess(req, res, dsId))) return undefined;
  const result = await scheduleService.retryFailedRun(savedQueryId, scheduleId, {
    callerUserId: callerId(req)
  });
  if (result.ok) {
    emitScheduleAudit(req, "saved_query.schedule.retried", savedQueryId, {
      schedule_id: scheduleId,
      run_id: result.body.run_id,
      delivery_ok: result.body.ok
    });
  }
  return writeResult(res, result);
}

module.exports = {
  handleCreateSchedule,
  handleListSchedules,
  handleUpdateSchedule,
  handleDeleteSchedule,
  handleRetrySchedule
};
