// QUERY-007: in-process dispatcher for scheduled saved-query delivery.
//
// Why in-process: we already run a single Node server (see start.js) and adding
// a second worker process / external queue would be heavy for the current scope.
// The dispatcher polls `saved_query_schedules` every `tickIntervalMs` (default
// 60s), picks rows whose `next_run_at <= now` and `status = 'active'`, and
// invokes `dispatchSchedule()` for each. The dispatch flow updates next_run_at
// itself, so a re-poll won't double-fire.
//
// Concurrency safety: we serialize one tick at a time per Node process. If the
// app is ever horizontally scaled, swap the polling-loop for a SELECT ... FOR
// UPDATE SKIP LOCKED claim, or move to a real queue. The runs table is
// idempotent-ish (a duplicate dispatch creates a separate runs row) so the
// worst-case is two emails for the same scheduled tick, not silent data loss.
//
// Disable in tests by leaving `SCHEDULE_DISPATCHER_ENABLED` unset (default
// "false"). Enable in prod by setting it to "true" in the environment.

const scheduleService = require("./savedQueryScheduleService");
const { logEvent } = require("../lib/observability");

let intervalHandle = null;
let runningTick = false;

async function tickOnce() {
  if (runningTick) return { skipped: true };
  runningTick = true;
  try {
    const due = await scheduleService.listDueSchedules(new Date(), 50);
    if (due.length === 0) {
      return { dispatched: 0 };
    }
    let succeeded = 0;
    let failed = 0;
    for (const schedule of due) {
      try {
        const result = await scheduleService.dispatchSchedule(schedule);
        if (result.ok) succeeded += 1;
        else failed += 1;
      } catch (err) {
        failed += 1;
        logEvent("schedule_dispatch_error", {
          schedule_id: schedule.id,
          saved_query_id: schedule.saved_query_id,
          error: err && err.message ? err.message : String(err)
        }, "error");
      }
    }
    logEvent("schedule_dispatcher_tick", {
      due_count: due.length,
      succeeded,
      failed
    });
    return { dispatched: due.length, succeeded, failed };
  } finally {
    runningTick = false;
  }
}

function startDispatcher({ tickIntervalMs = 60_000 } = {}) {
  if (intervalHandle) return intervalHandle;
  intervalHandle = setInterval(() => {
    tickOnce().catch((err) => {
      logEvent("schedule_dispatcher_tick_error", {
        error: err && err.message ? err.message : String(err)
      }, "error");
    });
  }, tickIntervalMs);
  // Don't keep the process alive solely because of the dispatcher (keeps test
  // teardown clean).
  if (typeof intervalHandle.unref === "function") intervalHandle.unref();
  logEvent("schedule_dispatcher_started", { tick_interval_ms: tickIntervalMs });
  return intervalHandle;
}

function stopDispatcher() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

function isEnabled() {
  return String(process.env.SCHEDULE_DISPATCHER_ENABLED || "false") === "true";
}

module.exports = {
  startDispatcher,
  stopDispatcher,
  tickOnce,
  isEnabled
};
