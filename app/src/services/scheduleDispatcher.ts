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

import * as scheduleService from "./savedQueryScheduleService";
import { logEvent } from "../lib/observability";
import { withTelemetrySpan } from "../lib/telemetry";

let intervalHandle: NodeJS.Timeout | null = null;
let runningTick = false;

export interface TickResult {
  skipped?: boolean;
  dispatched?: number;
  succeeded?: number;
  failed?: number;
}

export async function tickOnce(): Promise<TickResult> {
  return withTelemetrySpan("background.schedule_dispatch", {
    "pipeline.stage": "schedule_dispatch"
  }, tickOnceInternal);
}

async function tickOnceInternal(): Promise<TickResult> {
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
          error: (err && (err as Error).message) ? (err as Error).message : String(err)
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

export function startDispatcher({ tickIntervalMs = 60_000 }: { tickIntervalMs?: number } = {}): NodeJS.Timeout {
  if (intervalHandle) return intervalHandle;
  intervalHandle = setInterval(() => {
    tickOnce().catch((err: unknown) => {
      logEvent("schedule_dispatcher_tick_error", {
        error: (err && (err as Error).message) ? (err as Error).message : String(err)
      }, "error");
    });
  }, tickIntervalMs);
  // Don't keep the process alive solely because of the dispatcher (keeps test
  // teardown clean).
  if (typeof intervalHandle.unref === "function") intervalHandle.unref();
  logEvent("schedule_dispatcher_started", { tick_interval_ms: tickIntervalMs });
  return intervalHandle;
}

export function stopDispatcher(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

export function isEnabled(): boolean {
  return String(process.env.SCHEDULE_DISPATCHER_ENABLED || "false") === "true";
}
