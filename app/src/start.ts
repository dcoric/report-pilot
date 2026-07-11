import { runMigrations } from "./migrate";
import { startServer } from "./server";
import * as scheduleDispatcher from "./services/scheduleDispatcher";
import { errorMessage } from "./lib/http";
import { initializeTelemetry, type TelemetryHandle } from "./lib/telemetry";
import type { Server } from "http";

async function start(): Promise<{ server: Server; telemetry: TelemetryHandle }> {
  const telemetry = await initializeTelemetry();
  console.log("[boot] Running migrations...");
  try {
    await runMigrations({ maxRetries: 30, delayMs: 2000 });

    console.log("[boot] Starting HTTP server...");
    const server = await startServer();

    // QUERY-007: in-process scheduled-delivery worker. Off by default so tests
    // and bare `npm start` runs don't poll the DB; enable in deployment via
    // SCHEDULE_DISPATCHER_ENABLED=true.
    if (scheduleDispatcher.isEnabled()) {
      const intervalMs = Number(process.env.SCHEDULE_DISPATCHER_INTERVAL_MS || 60_000);
      scheduleDispatcher.startDispatcher({ tickIntervalMs: intervalMs });
      console.log(`[boot] Schedule dispatcher running every ${intervalMs}ms`);
    }
    return { server, telemetry };
  } catch (error) {
    await telemetry.shutdown();
    throw error;
  }
}

start().then(({ server, telemetry }) => {
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[boot] ${signal} received; shutting down`);
    scheduleDispatcher.stopDispatcher();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await telemetry.shutdown();
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}).catch((err: unknown) => {
  console.error(`[boot] Startup failed: ${errorMessage(err)}`);
  process.exit(1);
});
