const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";
process.env.PORT = "0";
process.env.AUTH_COOKIE_SECURE = "false";

const appDb = require("../src/lib/appDb");
const dbAdapterFactory = require("../src/adapters/dbAdapterFactory");
const emailService = require("../src/services/emailService");
const { createAuthTestStub } = require("./helpers/authTestStub");

const DATA_SOURCE_ID = "00000000-0000-4000-8000-000000000111";

let server;
let baseUrl;
let savedQueries;
let savedQueryShares;
let savedQueryVersions;
let schedules;
let scheduleRuns;
let savedQueryCounter;
let scheduleCounter;
let scheduleRunCounter;
let originalQuery;
let originalCreateDatabaseAdapter;
let originalIsSupportedDbType;
let originalSendExportEmail;
let sentEmails;
let emailFailureMode;
let authStub;
const testUsers = {};

function nextSavedQueryId() {
  savedQueryCounter += 1;
  return `00000000-0000-4000-8000-${String(savedQueryCounter).padStart(12, "0")}`;
}

function nextScheduleId() {
  scheduleCounter += 1;
  return `00000000-0000-4000-8000-dddd${String(scheduleCounter).padStart(8, "0")}`;
}

function nextScheduleRunId() {
  scheduleRunCounter += 1;
  return `00000000-0000-4000-8000-eeee${String(scheduleRunCounter).padStart(8, "0")}`;
}

function normalize(sql) {
  return String(sql).replace(/\s+/g, " ").trim().toLowerCase();
}

function ensureTestUser(label, role = "analyst") {
  if (testUsers[label]) return testUsers[label];
  const user = authStub.seedUser({
    email: `${label}@example.com`,
    roles: [role],
    dataSourceAccess: [DATA_SOURCE_ID]
  });
  const cookie = authStub.cookieFor(authStub.seedSession(user.id).token);
  testUsers[label] = { id: user.id, cookie, role };
  return testUsers[label];
}

function userId(label) {
  return ensureTestUser(label).id;
}

async function api(method, path, body, label = "owner", { role = "analyst" } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (label !== null) {
    const fixture = ensureTestUser(label, role);
    headers.Cookie = fixture.cookie;
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { status: response.status, payload };
}

async function seedSavedQuery({ ownerLabel = "owner", name = "Daily report", sql = "SELECT 1 AS value" } = {}) {
  const ownerId = userId(ownerLabel);
  const id = nextSavedQueryId();
  const now = new Date().toISOString();
  savedQueries.set(id, {
    id,
    owner_id: ownerId,
    name,
    description: null,
    data_source_id: DATA_SOURCE_ID,
    sql,
    default_run_params: {},
    parameter_schema: [],
    tags: [],
    visibility: "private",
    created_at: now,
    updated_at: now
  });
  return id;
}

before(async () => {
  originalQuery = appDb.query;
  originalCreateDatabaseAdapter = dbAdapterFactory.createDatabaseAdapter;
  originalIsSupportedDbType = dbAdapterFactory.isSupportedDbType;
  originalSendExportEmail = emailService.sendExportEmail;

  savedQueries = new Map();
  savedQueryShares = new Map();
  savedQueryVersions = new Map();
  schedules = new Map();
  scheduleRuns = new Map();
  savedQueryCounter = 0;
  scheduleCounter = 0;
  scheduleRunCounter = 0;
  sentEmails = [];
  emailFailureMode = null;
  authStub = createAuthTestStub();

  dbAdapterFactory.createDatabaseAdapter = () => ({
    async validateSql() {
      return { ok: true, errors: [], refs: [] };
    },
    async executeParameterizedReadOnly() {
      return {
        columns: ["value"],
        rows: [{ value: 1 }],
        rowCount: 1,
        durationMs: 4
      };
    },
    async close() {}
  });
  dbAdapterFactory.isSupportedDbType = (dbType) => dbType === "postgres" || dbType === "mssql";

  // Stub email transport so tests can assert on what would have been sent and
  // exercise the failure path without touching SMTP.
  emailService.sendExportEmail = async (opts) => {
    if (emailFailureMode === "throw") {
      throw new Error("SMTP unavailable (test stub)");
    }
    sentEmails.push({
      recipients: [...opts.recipients],
      subject: opts.subject,
      fileName: opts.fileName,
      bytes: opts.fileBuffer.length
    });
    return { messageId: `stub-${sentEmails.length}` };
  };

  appDb.query = async (sql, params = []) => {
    const auth = authStub.handleSql(sql, params);
    if (auth) return auth;
    const normalized = normalize(sql);

    if (normalized === "select id from data_sources where id = $1") {
      const [id] = params;
      if (id === DATA_SOURCE_ID) {
        return { rowCount: 1, rows: [{ id }] };
      }
      return { rowCount: 0, rows: [] };
    }

    if (normalized === "select data_source_id from saved_queries where id = $1") {
      const [id] = params;
      const row = savedQueries.get(id);
      return row
        ? { rowCount: 1, rows: [{ data_source_id: row.data_source_id }] }
        : { rowCount: 0, rows: [] };
    }

    if (normalized.startsWith("select id, owner_id, sql, data_source_id, default_run_params, parameter_schema from saved_queries where id = $1")) {
      const [id] = params;
      const row = savedQueries.get(id);
      return row ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] };
    }

    if (normalized.startsWith("select sq.id, sq.owner_id, sq.name, sq.description, sq.data_source_id, sq.sql, sq.default_run_params, sq.parameter_schema, sq.tags, sq.visibility, sq.created_at, sq.updated_at, ds.connection_ref, ds.db_type from saved_queries sq join data_sources ds on ds.id = sq.data_source_id where sq.id = $1")) {
      const [id] = params;
      const row = savedQueries.get(id);
      if (!row) return { rowCount: 0, rows: [] };
      return {
        rowCount: 1,
        rows: [{ ...row, connection_ref: "postgresql://example", db_type: "postgres" }]
      };
    }

    if (normalized.startsWith("select schema_name, object_name from schema_objects where data_source_id = $1")) {
      return { rowCount: 1, rows: [{ schema_name: "public", object_name: "revenue" }] };
    }

    // CRUD on saved_query_schedules
    if (normalized.startsWith("insert into saved_query_schedules")) {
      const [
        savedQueryId,
        ownerUserId,
        name,
        cronExpression,
        timezone,
        recipients,
        deliveryMode,
        format,
        parameterOverridesJson,
        status,
        nextRunAt
      ] = params;
      const now = new Date().toISOString();
      const row = {
        id: nextScheduleId(),
        saved_query_id: savedQueryId,
        owner_user_id: ownerUserId,
        name,
        cron_expression: cronExpression,
        timezone,
        recipients: Array.isArray(recipients) ? recipients : [],
        delivery_mode: deliveryMode,
        format,
        parameter_overrides: JSON.parse(parameterOverridesJson),
        status,
        next_run_at: nextRunAt,
        last_run_at: null,
        last_status: null,
        created_at: now,
        updated_at: now
      };
      schedules.set(row.id, row);
      return { rowCount: 1, rows: [row] };
    }

    if (normalized.startsWith("select id, saved_query_id, owner_user_id, name, cron_expression, timezone, recipients, delivery_mode, format, parameter_overrides, status, next_run_at, last_run_at, last_status, created_at, updated_at from saved_query_schedules where saved_query_id = $1")) {
      const [savedQueryId] = params;
      const rows = [...schedules.values()]
        .filter((row) => row.saved_query_id === savedQueryId)
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      return { rowCount: rows.length, rows };
    }

    if (normalized.startsWith("select id, saved_query_id, owner_user_id, name, cron_expression, timezone, recipients, delivery_mode, format, parameter_overrides, status, next_run_at, last_run_at, last_status, created_at, updated_at from saved_query_schedules where id = $1")) {
      const [id] = params;
      const row = schedules.get(id);
      return row ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] };
    }

    if (normalized.startsWith("select id, saved_query_id, owner_user_id, name, cron_expression, timezone, recipients, delivery_mode, format, parameter_overrides, status, next_run_at, last_run_at, last_status, created_at, updated_at from saved_query_schedules where status = 'active'")) {
      const [now, limit] = params;
      const rows = [...schedules.values()]
        .filter((row) => row.status === "active" && row.next_run_at && new Date(row.next_run_at) <= new Date(now))
        .sort((a, b) => new Date(a.next_run_at) - new Date(b.next_run_at))
        .slice(0, limit);
      return { rowCount: rows.length, rows };
    }

    if (normalized.startsWith("update saved_query_schedules set name = $2,")) {
      const [
        id,
        name,
        cronExpression,
        timezone,
        recipients,
        deliveryMode,
        format,
        parameterOverridesJson,
        status,
        nextRunAt
      ] = params;
      const existing = schedules.get(id);
      if (!existing) return { rowCount: 0, rows: [] };
      const updated = {
        ...existing,
        name,
        cron_expression: cronExpression,
        timezone,
        recipients: Array.isArray(recipients) ? recipients : [],
        delivery_mode: deliveryMode,
        format,
        parameter_overrides: JSON.parse(parameterOverridesJson),
        status,
        next_run_at: nextRunAt,
        updated_at: new Date().toISOString()
      };
      schedules.set(id, updated);
      return { rowCount: 1, rows: [updated] };
    }

    if (normalized.startsWith("update saved_query_schedules set last_status = 'running'")) {
      const [id] = params;
      const existing = schedules.get(id);
      if (existing) {
        schedules.set(id, { ...existing, last_status: "running", updated_at: new Date().toISOString() });
      }
      return { rowCount: existing ? 1 : 0, rows: [] };
    }

    if (normalized.startsWith("update saved_query_schedules set last_run_at = now(), last_status = 'succeeded'")) {
      const [id, nextRunAt] = params;
      const existing = schedules.get(id);
      if (existing) {
        schedules.set(id, {
          ...existing,
          last_run_at: new Date().toISOString(),
          last_status: "succeeded",
          next_run_at: nextRunAt,
          updated_at: new Date().toISOString()
        });
      }
      return { rowCount: existing ? 1 : 0, rows: [] };
    }

    if (normalized.startsWith("update saved_query_schedules set last_run_at = now(), last_status = 'failed'")) {
      const [id, nextRunAt] = params;
      const existing = schedules.get(id);
      if (existing) {
        schedules.set(id, {
          ...existing,
          last_run_at: new Date().toISOString(),
          last_status: "failed",
          next_run_at: nextRunAt,
          updated_at: new Date().toISOString()
        });
      }
      return { rowCount: existing ? 1 : 0, rows: [] };
    }

    if (normalized.startsWith("delete from saved_query_schedules where id = $1 returning id")) {
      const [id] = params;
      if (!schedules.has(id)) return { rowCount: 0, rows: [] };
      schedules.delete(id);
      // CASCADE clean-up of runs.
      for (const [runId, run] of [...scheduleRuns.entries()]) {
        if (run.schedule_id === id) scheduleRuns.delete(runId);
      }
      return { rowCount: 1, rows: [{ id }] };
    }

    // Runs
    if (normalized.startsWith("insert into saved_query_schedule_runs")) {
      const [
        scheduleId,
        savedQueryId,
        scheduledFor,
        startedAt,
        attempt,
        recipients,
        deliveryMode,
        format
      ] = params;
      const row = {
        id: nextScheduleRunId(),
        schedule_id: scheduleId,
        saved_query_id: savedQueryId,
        scheduled_for: scheduledFor,
        started_at: startedAt,
        completed_at: null,
        status: "running",
        attempt,
        recipients: Array.isArray(recipients) ? recipients : [],
        delivery_mode: deliveryMode,
        format,
        file_name: null,
        file_size_bytes: null,
        row_count: null,
        error_message: null
      };
      scheduleRuns.set(row.id, row);
      return { rowCount: 1, rows: [row] };
    }

    if (normalized.startsWith("update saved_query_schedule_runs set status = 'succeeded'")) {
      const [id, fileName, fileSize, rowCount] = params;
      const existing = scheduleRuns.get(id);
      if (existing) {
        scheduleRuns.set(id, {
          ...existing,
          status: "succeeded",
          completed_at: new Date().toISOString(),
          file_name: fileName,
          file_size_bytes: fileSize,
          row_count: rowCount
        });
      }
      return { rowCount: existing ? 1 : 0, rows: [] };
    }

    if (normalized.startsWith("update saved_query_schedule_runs set status = 'failed'")) {
      const [id, errMessage] = params;
      const existing = scheduleRuns.get(id);
      if (existing) {
        scheduleRuns.set(id, {
          ...existing,
          status: "failed",
          completed_at: new Date().toISOString(),
          error_message: errMessage
        });
      }
      return { rowCount: existing ? 1 : 0, rows: [] };
    }

    if (normalized.startsWith("select id, schedule_id, saved_query_id, scheduled_for, started_at, completed_at, status, attempt, recipients, delivery_mode, format, file_name, file_size_bytes, row_count, error_message from saved_query_schedule_runs where schedule_id = any")) {
      const [scheduleIds] = params;
      const set = new Set(scheduleIds);
      const rows = [...scheduleRuns.values()]
        .filter((row) => set.has(row.schedule_id))
        .sort((a, b) => {
          const dateDiff = new Date(b.scheduled_for) - new Date(a.scheduled_for);
          if (dateDiff !== 0) return dateDiff;
          if (b.attempt !== a.attempt) return b.attempt - a.attempt;
          const ta = a.started_at ? new Date(a.started_at).getTime() : 0;
          const tb = b.started_at ? new Date(b.started_at).getTime() : 0;
          return tb - ta;
        })
        .slice(0, 200);
      return { rowCount: rows.length, rows };
    }

    if (normalized.startsWith("select attempt, status from saved_query_schedule_runs where schedule_id = $1")) {
      const [scheduleId] = params;
      const rows = [...scheduleRuns.values()]
        .filter((row) => row.schedule_id === scheduleId)
        .sort((a, b) => new Date(b.scheduled_for) - new Date(a.scheduled_for))
        .slice(0, 1)
        .map((row) => ({ attempt: row.attempt, status: row.status }));
      return { rowCount: rows.length, rows };
    }

    if (normalized.startsWith("insert into auth_audit_log")) {
      return { rowCount: 1, rows: [] };
    }

    throw new Error(`Unexpected SQL in schedule test stub: ${normalized}`);
  };

  delete require.cache[require.resolve("../src/server")];
  const { startServer } = require("../src/server");
  server = await startServer();
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  savedQueries.clear();
  savedQueryShares.clear();
  savedQueryVersions.clear();
  schedules.clear();
  scheduleRuns.clear();
  savedQueryCounter = 0;
  scheduleCounter = 0;
  scheduleRunCounter = 0;
  sentEmails = [];
  emailFailureMode = null;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  appDb.query = originalQuery;
  dbAdapterFactory.createDatabaseAdapter = originalCreateDatabaseAdapter;
  dbAdapterFactory.isSupportedDbType = originalIsSupportedDbType;
  emailService.sendExportEmail = originalSendExportEmail;
});

test("QUERY-007 create + list + update + delete schedule happy path", async () => {
  const savedQueryId = await seedSavedQuery({ ownerLabel: "owner" });

  const create = await api("POST", `/v1/saved-queries/${savedQueryId}/schedules`, {
    name: "Weekday 9am",
    cron_expression: "0 9 * * 1-5",
    timezone: "UTC",
    recipients: ["ops@example.com", "lead@example.com"],
    delivery_mode: "email",
    format: "csv"
  }, "owner");
  assert.equal(create.status, 201);
  assert.equal(create.payload.name, "Weekday 9am");
  assert.equal(create.payload.cron_expression, "0 9 * * 1-5");
  assert.equal(create.payload.format, "csv");
  assert.deepEqual(create.payload.recipients, ["ops@example.com", "lead@example.com"]);
  assert.ok(create.payload.next_run_at);
  assert.equal(create.payload.status, "active");

  const list = await api("GET", `/v1/saved-queries/${savedQueryId}/schedules`, undefined, "owner");
  assert.equal(list.status, 200);
  assert.equal(list.payload.items.length, 1);
  assert.equal(list.payload.items[0].id, create.payload.id);
  assert.deepEqual(list.payload.items[0].recent_runs, []);

  const update = await api("PUT", `/v1/saved-queries/${savedQueryId}/schedules/${create.payload.id}`, {
    name: "Weekday 9am (paused)",
    status: "paused"
  }, "owner");
  assert.equal(update.status, 200);
  assert.equal(update.payload.status, "paused");
  assert.equal(update.payload.next_run_at, null);

  const del = await api("DELETE", `/v1/saved-queries/${savedQueryId}/schedules/${create.payload.id}`, undefined, "owner");
  assert.equal(del.status, 200);

  const after = await api("GET", `/v1/saved-queries/${savedQueryId}/schedules`, undefined, "owner");
  assert.equal(after.status, 200);
  assert.deepEqual(after.payload.items, []);
});

test("QUERY-007 rejects invalid cron, timezone, recipients, and format", async () => {
  const savedQueryId = await seedSavedQuery({ ownerLabel: "owner" });

  const badCron = await api("POST", `/v1/saved-queries/${savedQueryId}/schedules`, {
    name: "bad",
    cron_expression: "not a cron",
    recipients: ["x@example.com"]
  }, "owner");
  assert.equal(badCron.status, 400);
  assert.match(badCron.payload.message, /cron_expression/i);

  const badTz = await api("POST", `/v1/saved-queries/${savedQueryId}/schedules`, {
    name: "bad",
    cron_expression: "0 9 * * *",
    timezone: "Not/A/Real/Zone",
    recipients: ["x@example.com"]
  }, "owner");
  assert.equal(badTz.status, 400);
  assert.match(badTz.payload.message, /timezone/i);

  const badRecipients = await api("POST", `/v1/saved-queries/${savedQueryId}/schedules`, {
    name: "bad",
    cron_expression: "0 9 * * *",
    recipients: ["not-an-email"]
  }, "owner");
  assert.equal(badRecipients.status, 400);

  const noRecipients = await api("POST", `/v1/saved-queries/${savedQueryId}/schedules`, {
    name: "bad",
    cron_expression: "0 9 * * *",
    delivery_mode: "email"
  }, "owner");
  assert.equal(noRecipients.status, 400);
  assert.match(noRecipients.payload.message, /recipients/i);

  const badFormat = await api("POST", `/v1/saved-queries/${savedQueryId}/schedules`, {
    name: "bad",
    cron_expression: "0 9 * * *",
    recipients: ["x@example.com"],
    format: "pdf"
  }, "owner");
  assert.equal(badFormat.status, 400);
  assert.match(badFormat.payload.message, /format/i);
});

test("QUERY-007 schedules are owner-only — non-owners get 403", async () => {
  const savedQueryId = await seedSavedQuery({ ownerLabel: "owner" });

  // The other user has the schedule permission via their role, but the
  // service layer should still 403 them because they don't own the query.
  const create = await api("POST", `/v1/saved-queries/${savedQueryId}/schedules`, {
    name: "trying",
    cron_expression: "0 9 * * *",
    recipients: ["x@example.com"]
  }, "stranger");
  assert.equal(create.status, 403);

  const list = await api("GET", `/v1/saved-queries/${savedQueryId}/schedules`, undefined, "stranger");
  assert.equal(list.status, 403);
});

test("QUERY-007 download_artifact mode skips SMTP and still records the run", async () => {
  const savedQueryId = await seedSavedQuery({ ownerLabel: "owner" });

  const created = await api("POST", `/v1/saved-queries/${savedQueryId}/schedules`, {
    name: "Artifact only",
    cron_expression: "0 9 * * *",
    delivery_mode: "download_artifact",
    recipients: [],
    format: "json"
  }, "owner");
  assert.equal(created.status, 201);

  // Force a dispatch by calling the service directly. We can't easily exercise
  // the time-driven path from a unit test, so we drive the dispatcher entry
  // point. This is the same code path the retry endpoint and the worker call.
  const scheduleService = require("../src/services/savedQueryScheduleService");
  const schedule = schedules.get(created.payload.id);
  const result = await scheduleService.dispatchSchedule(schedule);
  assert.equal(result.ok, true);
  assert.equal(sentEmails.length, 0); // no email for download_artifact

  const runs = [...scheduleRuns.values()];
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "succeeded");
  assert.equal(runs[0].delivery_mode, "download_artifact");
  assert.ok(runs[0].file_name && runs[0].file_size_bytes > 0);
});

test("QUERY-007 dispatch failure records error_message and exposes it via list endpoint", async () => {
  const savedQueryId = await seedSavedQuery({ ownerLabel: "owner" });

  const created = await api("POST", `/v1/saved-queries/${savedQueryId}/schedules`, {
    name: "will fail",
    cron_expression: "0 9 * * *",
    recipients: ["ops@example.com"],
    format: "csv"
  }, "owner");
  assert.equal(created.status, 201);

  emailFailureMode = "throw";
  const scheduleService = require("../src/services/savedQueryScheduleService");
  const schedule = schedules.get(created.payload.id);
  const result = await scheduleService.dispatchSchedule(schedule);
  assert.equal(result.ok, false);
  assert.match(result.error, /SMTP unavailable/);

  const list = await api("GET", `/v1/saved-queries/${savedQueryId}/schedules`, undefined, "owner");
  assert.equal(list.status, 200);
  assert.equal(list.payload.items[0].last_status, "failed");
  assert.equal(list.payload.items[0].recent_runs.length, 1);
  assert.equal(list.payload.items[0].recent_runs[0].status, "failed");
  assert.match(list.payload.items[0].recent_runs[0].error_message, /SMTP unavailable/);

  // Manual retry via the API exposes a second attempt that succeeds once SMTP
  // is healthy again.
  emailFailureMode = null;
  const retry = await api("POST", `/v1/saved-queries/${savedQueryId}/schedules/${created.payload.id}/retry`, {}, "owner");
  assert.equal(retry.status, 200);
  assert.equal(retry.payload.ok, true);
  assert.ok(retry.payload.run_id);

  const finalList = await api("GET", `/v1/saved-queries/${savedQueryId}/schedules`, undefined, "owner");
  assert.equal(finalList.payload.items[0].last_status, "succeeded");
  assert.equal(finalList.payload.items[0].recent_runs.length, 2);
  // Newest first — retry attempt should be attempt 2.
  assert.equal(finalList.payload.items[0].recent_runs[0].attempt, 2);
  assert.equal(finalList.payload.items[0].recent_runs[0].status, "succeeded");
});

test("QUERY-007 successful email dispatch sends to recipients and records file size", async () => {
  const savedQueryId = await seedSavedQuery({ ownerLabel: "owner" });

  const created = await api("POST", `/v1/saved-queries/${savedQueryId}/schedules`, {
    name: "Monday digest",
    cron_expression: "0 9 * * 1",
    recipients: ["ops@example.com", "lead@example.com"],
    format: "xlsx"
  }, "owner");
  assert.equal(created.status, 201);

  const scheduleService = require("../src/services/savedQueryScheduleService");
  const schedule = schedules.get(created.payload.id);
  const result = await scheduleService.dispatchSchedule(schedule);
  assert.equal(result.ok, true);

  assert.equal(sentEmails.length, 1);
  assert.deepEqual(sentEmails[0].recipients.sort(), ["lead@example.com", "ops@example.com"]);
  assert.match(sentEmails[0].subject, /Monday digest/);
  assert.match(sentEmails[0].fileName, /\.xlsx$/);
  assert.ok(sentEmails[0].bytes > 0);

  const runs = [...scheduleRuns.values()];
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "succeeded");
  assert.equal(runs[0].row_count, 1);
  assert.match(runs[0].file_name, /\.xlsx$/);
});
