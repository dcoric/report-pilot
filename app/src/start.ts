import { runMigrations } from "./migrate";
import { startServer } from "./server";
import * as scheduleDispatcher from "./services/scheduleDispatcher";
import { errorMessage } from "./lib/http";

async function start(): Promise<void> {
  console.log("[boot] Running migrations...");
  await runMigrations({ maxRetries: 30, delayMs: 2000 });

  console.log("[boot] Starting HTTP server...");
  await startServer();

  // QUERY-007: in-process scheduled-delivery worker. Off by default so tests
  // and bare `npm start` runs don't poll the DB; enable in deployment via
  // SCHEDULE_DISPATCHER_ENABLED=true.
  if (scheduleDispatcher.isEnabled()) {
    const intervalMs = Number(process.env.SCHEDULE_DISPATCHER_INTERVAL_MS || 60_000);
    scheduleDispatcher.startDispatcher({ tickIntervalMs: intervalMs });
    console.log(`[boot] Schedule dispatcher running every ${intervalMs}ms`);
  }
}

start().catch((err: unknown) => {
  console.error(`[boot] Startup failed: ${errorMessage(err)}`);
  process.exit(1);
});
