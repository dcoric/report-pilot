import * as fs from "fs/promises";
import * as path from "path";
import appDb = require("../lib/appDb");

const DEFAULT_REPORT_DIR =
  process.env.BENCHMARK_REPORT_DIR || path.join(process.cwd(), "docs", "evals", "reports");
const DEFAULT_BENCHMARK_DATA_SOURCE = "dvdrental";
const DEFAULT_BENCHMARK_CONNECTION_REF = "postgresql://postgres:postgres@host.docker.internal:5440/dvdrental";
const DEFAULT_BENCHMARK_ORACLE_CONN = "postgresql://postgres:postgres@localhost:5440/dvdrental";

export interface NumberSummary {
  count: number;
  avg: number | null;
  p50: number | null;
  p95: number | null;
  max: number | null;
}

export interface ObservabilityMetrics {
  window_hours: number;
  generated_at: string;
  totals: {
    attempts: number;
    attempts_with_execution: number;
    attempts_with_explain: number;
  };
  latency_ms: {
    generation: NumberSummary;
    execution: NumberSummary;
  };
  query_cost: {
    explain_max_total_cost: NumberSummary;
    explain_max_plan_rows: NumberSummary;
    mean_explain_cost_per_attempt: number | null;
  };
  token_usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    avg_total_tokens_per_attempt: number | null;
  };
  provider_failures: Array<{ provider: string; failures: number }>;
}

export interface BenchmarkReleaseGates {
  found: boolean;
  source?: "database";
  report_id?: string;
  run_date?: string | Date | null;
  data_source_id?: string | null;
  summary?: Record<string, unknown> | null;
  release_gates?: Record<string, unknown> | null;
  report_file?: string;
  message?: string;
}

export interface BenchmarkCommand {
  command: string;
  env: Record<string, string>;
}

export async function buildObservabilityMetrics(opts: { windowHours?: number } = {}): Promise<ObservabilityMetrics> {
  const windowHours = clampWindowHours(opts.windowHours);

  interface AttemptRow {
    id: string;
    llm_provider: string | null;
    latency_ms: number | string | null;
    token_usage_json: Record<string, unknown> | null;
    validation_result_json: Record<string, unknown> | null;
    created_at: Date | string;
    execution_duration_ms: number | string | null;
  }

  const attemptsResult = await appDb.query<AttemptRow>(
    `
      SELECT
        qa.id,
        qa.llm_provider,
        qa.latency_ms,
        qa.token_usage_json,
        qa.validation_result_json,
        qa.created_at,
        qrm.duration_ms AS execution_duration_ms
      FROM query_attempts qa
      LEFT JOIN query_results_meta qrm ON qrm.attempt_id = qa.id
      WHERE qa.created_at >= NOW() - make_interval(hours => $1::int)
      ORDER BY qa.created_at ASC
    `,
    [windowHours]
  );

  const rows = attemptsResult.rows;
  const generationLatencies: number[] = [];
  const executionLatencies: number[] = [];
  const explainCosts: number[] = [];
  const explainRows: number[] = [];

  let tokenPrompt = 0;
  let tokenCompletion = 0;
  let tokenTotal = 0;

  const providerFailureCounts = new Map<string, number>();
  for (const row of rows) {
    const generationLatency = Number(row.latency_ms);
    if (Number.isFinite(generationLatency)) {
      generationLatencies.push(generationLatency);
    }

    const execLatency = Number(row.execution_duration_ms);
    if (Number.isFinite(execLatency)) {
      executionLatencies.push(execLatency);
    }

    const usage = normalizeTokenUsage(row.token_usage_json);
    if (usage) {
      tokenPrompt += usage.prompt_tokens;
      tokenCompletion += usage.completion_tokens;
      tokenTotal += usage.total_tokens;
    }

    const validation = (row.validation_result_json || {}) as Record<string, unknown>;
    const explainBudget = validation.explain_budget as Record<string, unknown> | undefined;
    const metrics = explainBudget?.metrics as Record<string, unknown> | undefined;
    if (metrics && Number.isFinite(Number(metrics.maxTotalCost))) {
      explainCosts.push(Number(metrics.maxTotalCost));
    }
    if (metrics && Number.isFinite(Number(metrics.maxPlanRows))) {
      explainRows.push(Number(metrics.maxPlanRows));
    }

    const providerAttempts = Array.isArray(validation.provider_attempts) ? validation.provider_attempts : [];
    for (const attempt of providerAttempts as Array<Record<string, unknown>>) {
      if (attempt?.status !== "failed") {
        continue;
      }
      const provider = String(attempt.provider || "unknown");
      providerFailureCounts.set(provider, (providerFailureCounts.get(provider) || 0) + 1);
    }
  }

  const providerFailures = Array.from(providerFailureCounts.entries())
    .map(([provider, failures]) => ({ provider, failures }))
    .sort((a, b) => b.failures - a.failures || a.provider.localeCompare(b.provider));

  const attemptsCount = rows.length;
  const attemptsWithExecution = executionLatencies.length;
  const attemptsWithExplain = explainCosts.length;

  const meanCostPerAttempt = attemptsWithExplain > 0 ? explainCosts.reduce((a, b) => a + b, 0) / attemptsWithExplain : null;

  return {
    window_hours: windowHours,
    generated_at: new Date().toISOString(),
    totals: {
      attempts: attemptsCount,
      attempts_with_execution: attemptsWithExecution,
      attempts_with_explain: attemptsWithExplain
    },
    latency_ms: {
      generation: summarizeNumbers(generationLatencies),
      execution: summarizeNumbers(executionLatencies)
    },
    query_cost: {
      explain_max_total_cost: summarizeNumbers(explainCosts),
      explain_max_plan_rows: summarizeNumbers(explainRows),
      mean_explain_cost_per_attempt: meanCostPerAttempt === null ? null : round2(meanCostPerAttempt)
    },
    token_usage: {
      prompt_tokens: tokenPrompt,
      completion_tokens: tokenCompletion,
      total_tokens: tokenTotal,
      avg_total_tokens_per_attempt: attemptsCount > 0 ? round2(tokenTotal / attemptsCount) : null
    },
    provider_failures: providerFailures
  };
}

export async function loadLatestBenchmarkReleaseGates(reportDir: string = DEFAULT_REPORT_DIR): Promise<BenchmarkReleaseGates> {
  interface BenchmarkRow {
    id: string;
    run_date: Date | string | null;
    data_source_id: string | null;
    summary_json: (Record<string, unknown> & { release_gates?: Record<string, unknown> }) | null;
  }

  const dbResult = await appDb.query<BenchmarkRow>(
    `
      SELECT
        id,
        run_date,
        data_source_id,
        summary_json
      FROM benchmark_reports
      ORDER BY created_at DESC
      LIMIT 1
    `
  );

  if ((dbResult.rowCount ?? 0) > 0) {
    const row = dbResult.rows[0];
    return {
      found: true,
      source: "database",
      report_id: row.id,
      run_date: row.run_date,
      data_source_id: row.data_source_id || null,
      summary: row.summary_json || null,
      release_gates: row.summary_json?.release_gates || null
    };
  }

  const dir = reportDir;
  let entries;

  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        found: false,
        message: `No benchmark reports found at ${dir}`
      };
    }
    throw err;
  }

  const jsonFiles = entries
    .filter((entry) => entry.isFile() && entry.name.startsWith("mvp-benchmark-") && entry.name.endsWith(".json"))
    .map((entry) => entry.name);

  if (jsonFiles.length === 0) {
    return {
      found: false,
      message: `No benchmark reports found at ${dir}`
    };
  }

  const stats = await Promise.all(
    jsonFiles.map(async (name) => {
      const filePath = path.join(dir, name);
      const stat = await fs.stat(filePath);
      return {
        filePath,
        mtimeMs: stat.mtimeMs
      };
    })
  );

  const latest = stats.sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  const raw = await fs.readFile(latest.filePath, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown> & { summary?: Record<string, unknown> & { release_gates?: Record<string, unknown> } };

  return {
    found: true,
    report_file: latest.filePath,
    run_date: (parsed.run_date as string | null) || null,
    data_source_id: (parsed.data_source_id as string | null) || null,
    summary: parsed.summary || null,
    release_gates: parsed.summary?.release_gates || null
  };
}

export function buildBenchmarkCommand(): BenchmarkCommand {
  const dataSourceName = process.env.BENCHMARK_DATA_SOURCE_NAME || DEFAULT_BENCHMARK_DATA_SOURCE;
  const fallbackConn = process.env.BENCHMARK_DATA_SOURCE_CONN || DEFAULT_BENCHMARK_ORACLE_CONN;
  const connectionRef = process.env.BENCHMARK_CONNECTION_REF || fallbackConn || DEFAULT_BENCHMARK_CONNECTION_REF;
  const oracleConn = process.env.BENCHMARK_ORACLE_CONN || fallbackConn || DEFAULT_BENCHMARK_ORACLE_CONN;
  const appBaseUrl = process.env.BENCHMARK_APP_BASE_URL || "";
  const provider = process.env.BENCHMARK_PROVIDER || "";
  const model = process.env.BENCHMARK_MODEL || "";

  const env: Record<string, string> = {
    BENCHMARK_DATA_SOURCE_NAME: dataSourceName,
    BENCHMARK_CONNECTION_REF: connectionRef,
    BENCHMARK_ORACLE_CONN: oracleConn
  };

  if (provider) {
    env.BENCHMARK_PROVIDER = provider;
  }
  if (model) {
    env.BENCHMARK_MODEL = model;
  }
  if (appBaseUrl) {
    env.BENCHMARK_APP_BASE_URL = appBaseUrl;
  }

  const commandLines = Object.entries(env).map(
    ([key, value]) => `${key}=${toShellLiteral(value)} \\`
  );
  commandLines.push("npm run benchmark:mvp");

  return {
    command: commandLines.join("\n"),
    env
  };
}

interface NormalizedTokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

function normalizeTokenUsage(raw: unknown): NormalizedTokenUsage | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const r = raw as Record<string, unknown>;

  const promptTokens = toFiniteNumber(r.prompt_tokens ?? r.promptTokenCount);
  const completionTokens = toFiniteNumber(r.completion_tokens ?? r.candidatesTokenCount ?? r.output_tokens);
  const totalTokens = toFiniteNumber(r.total_tokens ?? r.totalTokenCount);

  const normalizedPrompt = promptTokens || 0;
  const normalizedCompletion = completionTokens || 0;
  const normalizedTotal = totalTokens || normalizedPrompt + normalizedCompletion;

  return {
    prompt_tokens: normalizedPrompt,
    completion_tokens: normalizedCompletion,
    total_tokens: normalizedTotal
  };
}

function summarizeNumbers(values: number[]): NumberSummary {
  if (!Array.isArray(values) || values.length === 0) {
    return {
      count: 0,
      avg: null,
      p50: null,
      p95: null,
      max: null
    };
  }

  const sorted = values.slice().sort((a, b) => a - b);
  const count = sorted.length;
  const avg = sorted.reduce((a, b) => a + b, 0) / count;

  return {
    count,
    avg: round2(avg),
    p50: round2(percentileSorted(sorted, 0.5)),
    p95: round2(percentileSorted(sorted, 0.95)),
    max: round2(sorted[count - 1])
  };
}

function percentileSorted(sorted: number[], p: number): number {
  if (!Array.isArray(sorted) || sorted.length === 0) {
    return NaN;
  }
  const rank = Math.ceil(p * sorted.length) - 1;
  const idx = Math.max(0, Math.min(sorted.length - 1, rank));
  return sorted[idx];
}

function round2(value: number): number {
  return Number(Number(value).toFixed(2));
}

function toFiniteNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clampWindowHours(value: unknown): number {
  const n = Number(value || 24);
  if (!Number.isFinite(n)) {
    return 24;
  }
  return Math.max(1, Math.min(24 * 30, Math.round(n)));
}

function toShellLiteral(value: unknown): string {
  const source = String(value ?? "");
  const escaped = source.replace(/'/g, "'\\''");
  return `'${escaped}'`;
}
