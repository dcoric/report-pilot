import appDb = require("../lib/appDb");
import { json, badRequest, readJsonBody, type RouteHandler, type RouteHandlerWithUrl } from "../lib/http";
import {
  buildObservabilityMetrics,
  loadLatestBenchmarkReleaseGates,
  buildBenchmarkCommand
} from "../services/observabilityService";
import type { BenchmarkReportUploadRequest } from "../types";

const handleObservabilityMetrics: RouteHandlerWithUrl = async (_req, res, requestUrl) => {
  const windowHours = Number(requestUrl.searchParams.get("window_hours")) || 24;
  const metrics = await buildObservabilityMetrics({ windowHours });
  return json(res, 200, metrics);
};

const handleReleaseGates: RouteHandler = async (_req, res) => {
  const payload = await loadLatestBenchmarkReleaseGates();
  if (!payload.found) {
    return json(res, 404, {
      error: "not_found",
      message: payload.message
    });
  }
  return json(res, 200, payload);
};

const handleBenchmarkCommand: RouteHandler = async (_req, res) => {
  const payload = buildBenchmarkCommand();
  return json(res, 200, payload);
};

const handleCreateBenchmarkReport: RouteHandler<BenchmarkReportUploadRequest> = async (req, res) => {
  const body = await readJsonBody<Partial<BenchmarkReportUploadRequest>>(req);
  const {
    run_date: runDate,
    dataset_file: datasetFile,
    data_source_id: dataSourceId,
    provider,
    model,
    summary
  } = body;

  if (!runDate || !datasetFile || !summary || typeof summary !== "object") {
    return badRequest(res, "run_date, dataset_file and summary are required");
  }

  const inserted = await appDb.query(
    `
      INSERT INTO benchmark_reports (
        run_date,
        dataset_file,
        data_source_id,
        provider,
        model,
        summary_json,
        report_json
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, created_at
    `,
    [runDate, datasetFile, dataSourceId || null, provider || null, model || null, summary, body]
  );

  return json(res, 201, inserted.rows[0]);
};

export {
  handleObservabilityMetrics,
  handleReleaseGates,
  handleBenchmarkCommand,
  handleCreateBenchmarkReport
};
