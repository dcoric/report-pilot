// QUERY-007: scheduled report delivery for saved queries.
//
// CRUD service for `saved_query_schedules` + dispatch helpers for the in-process
// worker. The dispatcher itself lives in `scheduleDispatcher.js` and calls into
// `dispatchSchedule()` here.
//
// Permissions: the route layer applies `saved_queries.schedule` first (admin +
// analyst by default). On top of that, the service requires the caller to be
// the owner of the saved query — schedules write to the owner's recipients and
// are the owner's responsibility. Shared/granted recipients cannot schedule
// other people's queries, matching the QUERY-006 share semantics.

const appDb = require("../lib/appDb");
const { isUuid } = require("../lib/validation");
const { isCronExpressionValid, isTimezoneValid, computeNextRun } = require("./cronExpression");
const { SUPPORTED_FORMATS } = require("./exportService");
const { sendExportEmail } = require("./emailService");
const { createDatabaseAdapter, isSupportedDbType } = require("../adapters/dbAdapterFactory");
const { ensureLimit, sanitizeGeneratedSql, validateAndNormalizeSql } = require("./sqlSafety");
const {
  validateParameterValues,
  substitutePlaceholdersForValidation
} = require("./queryParameterService");

const SCHEDULE_COLUMNS = `
  id,
  saved_query_id,
  owner_user_id,
  name,
  cron_expression,
  timezone,
  recipients,
  delivery_mode,
  format,
  parameter_overrides,
  status,
  next_run_at,
  last_run_at,
  last_status,
  created_at,
  updated_at
`;

const RUN_COLUMNS = `
  id,
  schedule_id,
  saved_query_id,
  scheduled_for,
  started_at,
  completed_at,
  status,
  attempt,
  recipients,
  delivery_mode,
  format,
  file_name,
  file_size_bytes,
  row_count,
  error_message
`;

const ALLOWED_DELIVERY_MODES = new Set(["email", "download_artifact"]);
const ALLOWED_FORMATS = new Set(["json", "csv", "tsv", "xlsx", "parquet"]);
const ALLOWED_STATUSES = new Set(["active", "paused"]);
const MAX_RECIPIENTS = 25;
const MAX_NAME_LENGTH = 200;
const MAX_ATTEMPTS = 3;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function success(body, statusCode = 200) {
  return { ok: true, statusCode, body };
}
function failure(statusCode, body) {
  return { ok: false, statusCode, body };
}

async function loadSavedQuery(savedQueryId) {
  const result = await appDb.query(
    `SELECT id, owner_id, sql, data_source_id, default_run_params, parameter_schema
       FROM saved_queries WHERE id = $1`,
    [savedQueryId]
  );
  return result.rows[0] || null;
}

async function loadSchedule(scheduleId) {
  const result = await appDb.query(
    `SELECT ${SCHEDULE_COLUMNS} FROM saved_query_schedules WHERE id = $1`,
    [scheduleId]
  );
  return result.rows[0] || null;
}

function normalizeRecipients(value, deliveryMode) {
  if (value === undefined || value === null) {
    if (deliveryMode === "email") {
      return { ok: false, message: "recipients are required for email delivery" };
    }
    return { ok: true, value: [] };
  }
  if (!Array.isArray(value)) {
    return { ok: false, message: "recipients must be an array of email strings" };
  }
  const cleaned = [];
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry !== "string") {
      return { ok: false, message: "recipients must be an array of email strings" };
    }
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (!EMAIL_REGEX.test(trimmed)) {
      return { ok: false, message: `invalid recipient email: ${trimmed}` };
    }
    const lower = trimmed.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    cleaned.push(trimmed);
  }
  if (deliveryMode === "email" && cleaned.length === 0) {
    return { ok: false, message: "recipients are required for email delivery" };
  }
  if (cleaned.length > MAX_RECIPIENTS) {
    return { ok: false, message: `cannot exceed ${MAX_RECIPIENTS} recipients per schedule` };
  }
  return { ok: true, value: cleaned };
}

function normalizeParameterOverrides(value) {
  if (value === undefined || value === null) {
    return { ok: true, value: {} };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, message: "parameter_overrides must be an object" };
  }
  // The values themselves are validated against the saved query's parameter
  // schema at dispatch time (`validateParameterValues`). At persist time we
  // only ensure it's JSON-safe.
  try {
    JSON.stringify(value);
  } catch {
    return { ok: false, message: "parameter_overrides is not JSON-serialisable" };
  }
  return { ok: true, value };
}

function validateSchedulePayload(payload, { isUpdate = false } = {}) {
  const out = {};
  if (!isUpdate || payload.name !== undefined) {
    if (typeof payload.name !== "string" || !payload.name.trim()) {
      return { ok: false, message: "name is required" };
    }
    if (payload.name.length > MAX_NAME_LENGTH) {
      return { ok: false, message: `name cannot exceed ${MAX_NAME_LENGTH} characters` };
    }
    out.name = payload.name.trim();
  }
  if (!isUpdate || payload.cron_expression !== undefined) {
    if (!isCronExpressionValid(payload.cron_expression)) {
      return { ok: false, message: "cron_expression is not a valid 5-field cron" };
    }
    out.cron_expression = String(payload.cron_expression).trim().replace(/\s+/g, " ");
  }
  if (!isUpdate || payload.timezone !== undefined) {
    const tz = payload.timezone === undefined ? "UTC" : payload.timezone;
    if (!isTimezoneValid(tz)) {
      return { ok: false, message: `timezone is not a valid IANA name: ${tz}` };
    }
    out.timezone = tz;
  }
  if (!isUpdate || payload.delivery_mode !== undefined) {
    const mode = payload.delivery_mode === undefined ? "email" : payload.delivery_mode;
    if (!ALLOWED_DELIVERY_MODES.has(mode)) {
      return {
        ok: false,
        message: `delivery_mode must be one of: ${[...ALLOWED_DELIVERY_MODES].join(", ")}`
      };
    }
    out.delivery_mode = mode;
  }
  if (!isUpdate || payload.format !== undefined) {
    const fmt = payload.format === undefined ? "csv" : payload.format;
    if (!ALLOWED_FORMATS.has(fmt) || !SUPPORTED_FORMATS.has(fmt)) {
      return { ok: false, message: `format must be one of: ${[...ALLOWED_FORMATS].join(", ")}` };
    }
    out.format = fmt;
  }
  if (!isUpdate || payload.recipients !== undefined) {
    const deliveryMode = out.delivery_mode || payload.delivery_mode || "email";
    const recipients = normalizeRecipients(payload.recipients, deliveryMode);
    if (!recipients.ok) return recipients;
    out.recipients = recipients.value;
  }
  if (!isUpdate || payload.parameter_overrides !== undefined) {
    const overrides = normalizeParameterOverrides(payload.parameter_overrides);
    if (!overrides.ok) return overrides;
    out.parameter_overrides = overrides.value;
  }
  if (!isUpdate || payload.status !== undefined) {
    const status = payload.status === undefined ? "active" : payload.status;
    if (!ALLOWED_STATUSES.has(status)) {
      return { ok: false, message: `status must be one of: ${[...ALLOWED_STATUSES].join(", ")}` };
    }
    out.status = status;
  }
  return { ok: true, value: out };
}

async function createSchedule(savedQueryId, payload, { callerUserId }) {
  if (!isUuid(savedQueryId)) {
    return failure(400, { error: "bad_request", message: "savedQueryId must be a valid UUID" });
  }
  const savedQuery = await loadSavedQuery(savedQueryId);
  if (!savedQuery) {
    return failure(404, { error: "not_found", message: "Saved query not found" });
  }
  if (!callerUserId) {
    return failure(401, { error: "unauthenticated" });
  }
  if (savedQuery.owner_id !== callerUserId) {
    return failure(403, {
      error: "forbidden",
      message: "Only the owner can schedule deliveries for this saved query"
    });
  }
  const validation = validateSchedulePayload(payload, { isUpdate: false });
  if (!validation.ok) {
    return failure(400, { error: "bad_request", message: validation.message });
  }
  const v = validation.value;
  // Compute the next run from "now" so a freshly created schedule fires on the
  // next matching minute and not retroactively for past minutes.
  const nextRunAt = v.status === "paused"
    ? null
    : computeNextRun(v.cron_expression, v.timezone, new Date());

  const result = await appDb.query(
    `
      INSERT INTO saved_query_schedules (
        saved_query_id, owner_user_id, name, cron_expression, timezone,
        recipients, delivery_mode, format, parameter_overrides, status, next_run_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6::text[], $7, $8, $9::jsonb, $10, $11
      )
      RETURNING ${SCHEDULE_COLUMNS}
    `,
    [
      savedQueryId,
      callerUserId,
      v.name,
      v.cron_expression,
      v.timezone,
      v.recipients,
      v.delivery_mode,
      v.format,
      JSON.stringify(v.parameter_overrides),
      v.status,
      nextRunAt
    ]
  );
  return success(result.rows[0], 201);
}

async function listSchedules(savedQueryId, { callerUserId }) {
  if (!isUuid(savedQueryId)) {
    return failure(400, { error: "bad_request", message: "savedQueryId must be a valid UUID" });
  }
  const savedQuery = await loadSavedQuery(savedQueryId);
  if (!savedQuery) {
    return failure(404, { error: "not_found", message: "Saved query not found" });
  }
  // Read access: owner only. Recipients of shared queries cannot see who else
  // is on the schedule.
  if (callerUserId && savedQuery.owner_id !== callerUserId) {
    return failure(403, {
      error: "forbidden",
      message: "Only the owner can view schedules for this saved query"
    });
  }
  const result = await appDb.query(
    `SELECT ${SCHEDULE_COLUMNS} FROM saved_query_schedules
      WHERE saved_query_id = $1
      ORDER BY created_at ASC`,
    [savedQueryId]
  );
  // Attach recent run history per schedule (up to last 10) so the UI can render
  // "last delivered" / retry context without a second round trip.
  if (result.rows.length === 0) return success({ items: [] });
  const scheduleIds = result.rows.map((row) => row.id);
  const runsResult = await appDb.query(
    `
      SELECT ${RUN_COLUMNS}
        FROM saved_query_schedule_runs
       WHERE schedule_id = ANY($1::uuid[])
       ORDER BY scheduled_for DESC, attempt DESC, started_at DESC NULLS LAST
       LIMIT 200
    `,
    [scheduleIds]
  );
  const runsBySchedule = new Map();
  for (const run of runsResult.rows) {
    if (!runsBySchedule.has(run.schedule_id)) runsBySchedule.set(run.schedule_id, []);
    const list = runsBySchedule.get(run.schedule_id);
    if (list.length < 10) list.push(run);
  }
  const items = result.rows.map((row) => ({
    ...row,
    recent_runs: runsBySchedule.get(row.id) || []
  }));
  return success({ items });
}

async function updateSchedule(savedQueryId, scheduleId, payload, { callerUserId }) {
  if (!isUuid(savedQueryId) || !isUuid(scheduleId)) {
    return failure(400, { error: "bad_request", message: "Both ids must be valid UUIDs" });
  }
  const savedQuery = await loadSavedQuery(savedQueryId);
  if (!savedQuery) {
    return failure(404, { error: "not_found", message: "Saved query not found" });
  }
  if (callerUserId && savedQuery.owner_id !== callerUserId) {
    return failure(403, {
      error: "forbidden",
      message: "Only the owner can update schedules for this saved query"
    });
  }
  const existing = await loadSchedule(scheduleId);
  if (!existing || existing.saved_query_id !== savedQueryId) {
    return failure(404, { error: "not_found", message: "Schedule not found" });
  }
  const merged = {
    name: existing.name,
    cron_expression: existing.cron_expression,
    timezone: existing.timezone,
    recipients: existing.recipients,
    delivery_mode: existing.delivery_mode,
    format: existing.format,
    parameter_overrides: existing.parameter_overrides,
    status: existing.status,
    ...payload
  };
  const validation = validateSchedulePayload(merged, { isUpdate: false });
  if (!validation.ok) {
    return failure(400, { error: "bad_request", message: validation.message });
  }
  const v = validation.value;
  // Recompute next_run_at whenever cron / timezone / status changes, or when
  // resuming from paused. Always recompute on edit to keep semantics simple.
  let nextRunAt = existing.next_run_at;
  if (v.status === "paused") {
    nextRunAt = null;
  } else if (
    v.cron_expression !== existing.cron_expression
    || v.timezone !== existing.timezone
    || existing.status === "paused"
    || nextRunAt === null
  ) {
    nextRunAt = computeNextRun(v.cron_expression, v.timezone, new Date());
  }

  const result = await appDb.query(
    `
      UPDATE saved_query_schedules
         SET name = $2,
             cron_expression = $3,
             timezone = $4,
             recipients = $5::text[],
             delivery_mode = $6,
             format = $7,
             parameter_overrides = $8::jsonb,
             status = $9,
             next_run_at = $10,
             updated_at = NOW()
       WHERE id = $1
       RETURNING ${SCHEDULE_COLUMNS}
    `,
    [
      scheduleId,
      v.name,
      v.cron_expression,
      v.timezone,
      v.recipients,
      v.delivery_mode,
      v.format,
      JSON.stringify(v.parameter_overrides),
      v.status,
      nextRunAt
    ]
  );
  return success(result.rows[0]);
}

async function deleteSchedule(savedQueryId, scheduleId, { callerUserId }) {
  if (!isUuid(savedQueryId) || !isUuid(scheduleId)) {
    return failure(400, { error: "bad_request", message: "Both ids must be valid UUIDs" });
  }
  const savedQuery = await loadSavedQuery(savedQueryId);
  if (!savedQuery) {
    return failure(404, { error: "not_found", message: "Saved query not found" });
  }
  if (callerUserId && savedQuery.owner_id !== callerUserId) {
    return failure(403, {
      error: "forbidden",
      message: "Only the owner can delete schedules for this saved query"
    });
  }
  const existing = await loadSchedule(scheduleId);
  if (!existing || existing.saved_query_id !== savedQueryId) {
    return failure(404, { error: "not_found", message: "Schedule not found" });
  }
  const result = await appDb.query(
    `DELETE FROM saved_query_schedules WHERE id = $1 RETURNING id`,
    [scheduleId]
  );
  if (result.rowCount === 0) {
    return failure(404, { error: "not_found", message: "Schedule not found" });
  }
  return success({ ok: true, id: result.rows[0].id });
}

async function loadSavedQueryForExecution(savedQueryId) {
  const result = await appDb.query(
    `
      SELECT
        sq.id,
        sq.owner_id,
        sq.name,
        sq.description,
        sq.data_source_id,
        sq.sql,
        sq.default_run_params,
        sq.parameter_schema,
        sq.tags,
        sq.visibility,
        sq.created_at,
        sq.updated_at,
        ds.connection_ref,
        ds.db_type
      FROM saved_queries sq
      JOIN data_sources ds ON ds.id = sq.data_source_id
      WHERE sq.id = $1
    `,
    [savedQueryId]
  );
  return result.rows[0] || null;
}

async function loadSchemaObjects(dataSourceId) {
  const result = await appDb.query(
    `
      SELECT schema_name, object_name
      FROM schema_objects
      WHERE data_source_id = $1
        AND is_ignored = FALSE
        AND object_type IN ('table', 'view', 'materialized_view')
    `,
    [dataSourceId]
  );
  return result.rows;
}

// Execute the saved query with the schedule's parameter overrides, render the
// chosen format, and return a buffer+filename. Mirrors the manual /run + /export
// path but is self-contained so manual flows stay untouched.
async function runScheduledQuery(savedQueryId, parameterOverrides, format) {
  const savedQuery = await loadSavedQueryForExecution(savedQueryId);
  if (!savedQuery) {
    throw new Error(`Saved query not found: ${savedQueryId}`);
  }
  if (!isSupportedDbType(savedQuery.db_type)) {
    throw new Error(`Unsupported db_type for execution: ${savedQuery.db_type}`);
  }
  const parameterValidation = validateParameterValues(
    savedQuery.parameter_schema,
    parameterOverrides || {}
  );
  if (!parameterValidation.ok) {
    throw new Error(
      `Invalid scheduled parameters: ${parameterValidation.errors.map((e) => e.message || e).join("; ")}`
    );
  }
  const dialect = savedQuery.db_type === "mssql" ? "mssql" : "postgres";
  const maxRows = Math.min(
    Number(savedQuery.default_run_params?.max_rows) > 0
      ? Number(savedQuery.default_run_params.max_rows)
      : 10000,
    100000
  );
  const timeoutMs = Math.min(
    Number(savedQuery.default_run_params?.timeout_ms) > 0
      ? Number(savedQuery.default_run_params.timeout_ms)
      : 60000,
    120000
  );
  const executableSql = ensureLimit(sanitizeGeneratedSql(savedQuery.sql), maxRows, dialect);
  const schemaObjects = await loadSchemaObjects(savedQuery.data_source_id);
  const validationSql = substitutePlaceholdersForValidation(executableSql, savedQuery.parameter_schema);
  const normalized = validateAndNormalizeSql(validationSql, {
    maxRows,
    schemaObjects,
    dialect
  });
  if (!normalized.ok) {
    throw new Error(`SQL safety check failed: ${normalized.errors.join("; ")}`);
  }
  let adapter = null;
  let rows;
  let columns;
  try {
    adapter = createDatabaseAdapter(savedQuery.db_type, savedQuery.connection_ref);
    const adapterValidation = await adapter.validateSql(normalized.sql);
    if (!adapterValidation.ok) {
      throw new Error(`Adapter validation failed: ${adapterValidation.errors.join("; ")}`);
    }
    const execution = await adapter.executeParameterizedReadOnly(
      executableSql,
      parameterValidation.resolvedValues,
      savedQuery.parameter_schema,
      { maxRows, timeoutMs }
    );
    rows = execution.rows;
    columns = execution.columns;
  } finally {
    if (adapter) await adapter.close();
  }
  return renderExportInline(rows, columns, savedQuery.name, format);
}

// Inline renderer. We mirror exportService's format branches rather than going
// through exportService.exportQueryResult, because that helper rehydrates from
// a query_session that scheduled runs do not have. Same dependencies, same
// supported formats.
async function renderExportInline(rows, columns, queryName, format) {
  const { stringify } = require("csv-stringify/sync");
  const xlsx = require("xlsx");
  const safeName = String(queryName || "scheduled_report").replace(/[^a-z0-9]/gi, "_").slice(0, 50);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const columnOrder = Array.isArray(columns) && columns.length > 0
    ? columns
    : (rows[0] ? Object.keys(rows[0]) : []);

  const filename = `${safeName}_${stamp}.${format}`;

  if (format === "csv") {
    return {
      buffer: Buffer.from(stringify(rows, { header: true, columns: columnOrder.length ? columnOrder : undefined }), "utf8"),
      contentType: "text/csv; charset=utf-8",
      filename,
      rowCount: rows.length
    };
  }
  if (format === "tsv") {
    return {
      buffer: Buffer.from(stringify(rows, {
        header: true,
        columns: columnOrder.length ? columnOrder : undefined,
        delimiter: "\t"
      }), "utf8"),
      contentType: "text/tab-separated-values; charset=utf-8",
      filename,
      rowCount: rows.length
    };
  }
  if (format === "xlsx") {
    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.json_to_sheet(rows, { header: columnOrder.length ? columnOrder : undefined });
    xlsx.utils.book_append_sheet(wb, ws, "Results");
    return {
      buffer: xlsx.write(wb, { type: "buffer", bookType: "xlsx" }),
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      filename,
      rowCount: rows.length
    };
  }
  if (format === "parquet") {
    if (rows.length === 0) {
      return {
        buffer: Buffer.from("[]", "utf8"),
        contentType: "application/json; charset=utf-8",
        filename: `${safeName}_${stamp}.json`,
        rowCount: 0
      };
    }
    const parquet = require("parquetjs-lite");
    const fs = require("fs/promises");
    const os = require("os");
    const path = require("path");
    const schemaDefinition = {};
    for (const column of columnOrder) {
      schemaDefinition[column] = { type: "UTF8", optional: true };
    }
    const schema = new parquet.ParquetSchema(schemaDefinition);
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "report-pilot-schedule-"));
    const filePath = path.join(tempDir, `export-${Date.now()}.parquet`);
    let writer;
    try {
      writer = await parquet.ParquetWriter.openFile(schema, filePath);
      for (const row of rows) {
        const normalizedRow = {};
        for (const column of columnOrder) {
          const v = row[column];
          normalizedRow[column] = v === null || v === undefined ? null : String(v);
        }
        await writer.appendRow(normalizedRow);
      }
      await writer.close();
      writer = null;
      const buffer = await fs.readFile(filePath);
      return {
        buffer,
        contentType: "application/vnd.apache.parquet",
        filename,
        rowCount: rows.length
      };
    } finally {
      if (writer) await writer.close().catch(() => {});
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
  return {
    buffer: Buffer.from(JSON.stringify(rows, null, 2), "utf8"),
    contentType: "application/json; charset=utf-8",
    filename,
    rowCount: rows.length
  };
}

// One full dispatch: insert a run row, attempt delivery, update both the run +
// the schedule's next_run_at. Used by the dispatcher and by the retry endpoint.
async function dispatchSchedule(schedule, { scheduledFor = null, attempt = 1 } = {}) {
  const now = new Date();
  const runScheduledFor = scheduledFor || schedule.next_run_at || now;
  const runResult = await appDb.query(
    `
      INSERT INTO saved_query_schedule_runs (
        schedule_id, saved_query_id, scheduled_for, started_at, status, attempt,
        recipients, delivery_mode, format
      ) VALUES ($1, $2, $3, $4, 'running', $5, $6::text[], $7, $8)
      RETURNING ${RUN_COLUMNS}
    `,
    [
      schedule.id,
      schedule.saved_query_id,
      runScheduledFor,
      now,
      attempt,
      schedule.recipients || [],
      schedule.delivery_mode,
      schedule.format
    ]
  );
  const run = runResult.rows[0];
  await appDb.query(
    `UPDATE saved_query_schedules SET last_status = 'running', updated_at = NOW() WHERE id = $1`,
    [schedule.id]
  );
  try {
    const rendered = await runScheduledQuery(
      schedule.saved_query_id,
      schedule.parameter_overrides || {},
      schedule.format
    );
    if (schedule.delivery_mode === "email") {
      await sendExportEmail({
        recipients: schedule.recipients,
        subject: `Report Pilot Scheduled Report: ${schedule.name}`,
        textBody:
          `Your scheduled report "${schedule.name}" is attached.\n\n`
          + `Format: ${schedule.format.toUpperCase()}\n`
          + `Rows: ${rendered.rowCount}\n`
          + `File: ${rendered.filename}\n`
          + `Scheduled for: ${new Date(runScheduledFor).toISOString()}\n`,
        fileBuffer: rendered.buffer,
        fileName: rendered.filename,
        contentType: rendered.contentType
      });
    }
    // For download_artifact mode we record the file metadata only; the bytes
    // themselves are not persisted (matches the existing export_deliveries
    // pattern which is also stateless on file content).
    const nextRunAt = schedule.status === "paused"
      ? null
      : computeNextRun(schedule.cron_expression, schedule.timezone, new Date());
    await appDb.query(
      `
        UPDATE saved_query_schedule_runs
           SET status = 'succeeded',
               completed_at = NOW(),
               file_name = $2,
               file_size_bytes = $3,
               row_count = $4
         WHERE id = $1
      `,
      [run.id, rendered.filename, rendered.buffer.length, rendered.rowCount]
    );
    await appDb.query(
      `
        UPDATE saved_query_schedules
           SET last_run_at = NOW(),
               last_status = 'succeeded',
               next_run_at = $2,
               updated_at = NOW()
         WHERE id = $1
      `,
      [schedule.id, nextRunAt]
    );
    return { ok: true, runId: run.id, filename: rendered.filename, rowCount: rendered.rowCount };
  } catch (err) {
    const errMessage = err && err.message ? String(err.message).slice(0, 2000) : "unknown error";
    await appDb.query(
      `
        UPDATE saved_query_schedule_runs
           SET status = 'failed', completed_at = NOW(), error_message = $2
         WHERE id = $1
      `,
      [run.id, errMessage]
    );
    // Bump next_run_at to the next cron tick even on failure — the schedule
    // keeps running. Per-attempt retries are surfaced via the runs history,
    // and an explicit POST /retry endpoint can re-attempt before then.
    const nextRunAt = schedule.status === "paused"
      ? null
      : computeNextRun(schedule.cron_expression, schedule.timezone, new Date());
    await appDb.query(
      `
        UPDATE saved_query_schedules
           SET last_run_at = NOW(),
               last_status = 'failed',
               next_run_at = $2,
               updated_at = NOW()
         WHERE id = $1
      `,
      [schedule.id, nextRunAt]
    );
    return { ok: false, runId: run.id, error: errMessage };
  }
}

async function listDueSchedules(now = new Date(), limit = 50) {
  const result = await appDb.query(
    `
      SELECT ${SCHEDULE_COLUMNS}
        FROM saved_query_schedules
       WHERE status = 'active'
         AND next_run_at IS NOT NULL
         AND next_run_at <= $1
       ORDER BY next_run_at ASC
       LIMIT $2
    `,
    [now, limit]
  );
  return result.rows;
}

// Manual retry: re-dispatch the latest run for this schedule. Bumps the
// `attempt` counter so the runs table reflects the retry chain. Capped at
// MAX_ATTEMPTS attempts to keep an owner from looping indefinitely on a
// permanently-broken target — they can edit the schedule (recipients, SQL,
// etc.) to reset the chain.
async function retryFailedRun(savedQueryId, scheduleId, { callerUserId }) {
  if (!isUuid(savedQueryId) || !isUuid(scheduleId)) {
    return failure(400, { error: "bad_request", message: "Both ids must be valid UUIDs" });
  }
  const savedQuery = await loadSavedQuery(savedQueryId);
  if (!savedQuery) {
    return failure(404, { error: "not_found", message: "Saved query not found" });
  }
  if (callerUserId && savedQuery.owner_id !== callerUserId) {
    return failure(403, { error: "forbidden", message: "Only the owner can retry scheduled deliveries" });
  }
  const schedule = await loadSchedule(scheduleId);
  if (!schedule || schedule.saved_query_id !== savedQueryId) {
    return failure(404, { error: "not_found", message: "Schedule not found" });
  }
  const latest = await appDb.query(
    `SELECT attempt, status FROM saved_query_schedule_runs
      WHERE schedule_id = $1 ORDER BY scheduled_for DESC LIMIT 1`,
    [scheduleId]
  );
  const lastAttempt = latest.rows[0]?.attempt ?? 0;
  if (lastAttempt >= MAX_ATTEMPTS) {
    return failure(429, {
      error: "too_many_attempts",
      message: `Reached the retry cap of ${MAX_ATTEMPTS} attempts. Edit the schedule and try again.`
    });
  }
  const dispatch = await dispatchSchedule(schedule, { attempt: lastAttempt + 1 });
  return success({ ok: dispatch.ok, run_id: dispatch.runId, error: dispatch.error || null });
}

module.exports = {
  createSchedule,
  listSchedules,
  updateSchedule,
  deleteSchedule,
  dispatchSchedule,
  listDueSchedules,
  retryFailedRun,
  validateSchedulePayload,
  EMAIL_REGEX,
  MAX_ATTEMPTS
};
