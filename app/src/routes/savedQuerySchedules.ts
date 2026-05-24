// QUERY-007: routes for managing scheduled saved-query delivery.

import appDb = require("../lib/appDb");
import type { ServerResponse } from "http";
import { enforceDataSourceAccess, type AuthedRequest } from "../lib/authGate";
import { json, readJsonBody } from "../lib/http";
import { isUuid } from "../lib/validation";
import * as scheduleService from "../services/savedQueryScheduleService";
import * as auditService from "../services/auditService";

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
  return result.rowCount > 0 ? (result.rows[0] as { data_source_id: string | null }).data_source_id : null;
}

function emitScheduleAudit(req: AuthedRequest, action: string, savedQueryId: string, details: Record<string, unknown> = {}) {
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

async function handleCreateSchedule(req: AuthedRequest, res: ServerResponse, savedQueryId: string): Promise<void> {
  const dsId = await loadSavedQueryDataSourceId(savedQueryId);
  if (dsId && !(await enforceDataSourceAccess(req, res, dsId))) return undefined;
  const body = await readJsonBody(req) as Record<string, unknown>;
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

async function handleListSchedules(req: AuthedRequest, res: ServerResponse, savedQueryId: string): Promise<void> {
  const dsId = await loadSavedQueryDataSourceId(savedQueryId);
  if (dsId && !(await enforceDataSourceAccess(req, res, dsId))) return undefined;
  const result = await scheduleService.listSchedules(savedQueryId, {
    callerUserId: callerId(req)
  });
  return writeResult(res, result);
}

async function handleUpdateSchedule(req: AuthedRequest, res: ServerResponse, savedQueryId: string, scheduleId: string): Promise<void> {
  const dsId = await loadSavedQueryDataSourceId(savedQueryId);
  if (dsId && !(await enforceDataSourceAccess(req, res, dsId))) return undefined;
  const body = await readJsonBody(req) as Record<string, unknown>;
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

async function handleDeleteSchedule(req: AuthedRequest, res: ServerResponse, savedQueryId: string, scheduleId: string): Promise<void> {
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

async function handleRetrySchedule(req: AuthedRequest, res: ServerResponse, savedQueryId: string, scheduleId: string): Promise<void> {
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

export {
  handleCreateSchedule,
  handleListSchedules,
  handleUpdateSchedule,
  handleDeleteSchedule,
  handleRetrySchedule
};
