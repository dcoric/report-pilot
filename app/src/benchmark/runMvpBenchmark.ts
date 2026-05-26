import * as fs from "fs/promises";
import * as path from "path";
import { Client } from "pg";
import { errorMessage } from "../lib/http";

const APP_BASE_URL = String(process.env.BENCHMARK_APP_BASE_URL || "http://localhost:8080").replace(/\/$/, "");
const BENCHMARK_FILE = process.env.BENCHMARK_FILE || path.join(process.cwd(), "docs", "evals", "dvdrental-mvp-benchmark.json");
const BENCHMARK_REPORT_DIR =
  process.env.BENCHMARK_REPORT_DIR || path.join(process.cwd(), "docs", "evals", "reports");
const BENCHMARK_DATA_SOURCE_ID = process.env.BENCHMARK_DATA_SOURCE_ID || "";
const BENCHMARK_DATA_SOURCE_NAME = process.env.BENCHMARK_DATA_SOURCE_NAME || "dvdrental";
const BENCHMARK_DATA_SOURCE_CONN =
  process.env.BENCHMARK_DATA_SOURCE_CONN || "postgresql://postgres:postgres@localhost:5440/dvdrental";
const BENCHMARK_CONNECTION_REF = process.env.BENCHMARK_CONNECTION_REF || BENCHMARK_DATA_SOURCE_CONN;
const BENCHMARK_ORACLE_CONN = process.env.BENCHMARK_ORACLE_CONN || BENCHMARK_DATA_SOURCE_CONN;
const BENCHMARK_MAX_CASES = Number(process.env.BENCHMARK_MAX_CASES || 0);
const BENCHMARK_MAX_ROWS = Number(process.env.BENCHMARK_MAX_ROWS || 2000);
const BENCHMARK_TIMEOUT_MS = Number(process.env.BENCHMARK_TIMEOUT_MS || 30000);
const BENCHMARK_INTROSPECTION_TIMEOUT_MS = Number(process.env.BENCHMARK_INTROSPECTION_TIMEOUT_MS || 180000);
const BENCHMARK_PROVIDER = process.env.BENCHMARK_PROVIDER || "";
const BENCHMARK_MODEL = process.env.BENCHMARK_MODEL || "";

const BLOCKED_SQL_KEYWORDS = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "ALTER",
  "DROP",
  "TRUNCATE",
  "CREATE",
  "GRANT",
  "REVOKE",
  "MERGE"
];

interface BenchmarkCase {
  id: string;
  nl_question: string;
  oracle_sql: string;
  result_assertion?: string;
}

interface RequestJsonResult<T = unknown> {
  ok: boolean;
  status: number;
  payload: T | null;
}

interface AssertionOutcome {
  ok: boolean;
  reason: string | null;
}

interface CaseResult {
  id: string;
  question: string;
  run_status: number;
  error: string | null;
  correct: boolean;
  mismatch_reason?: string | null;
  critical_safety_violation: boolean;
  e2e_latency_ms: number | null;
  generated_sql?: string | null;
  provider?: string | null;
  row_count_generated?: number;
  row_count_oracle?: number;
}

interface RunContext {
  dataSourceId: string;
  targetClient: Client;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readCases(filePath: string): Promise<BenchmarkCase[]> {
  const raw = await fs.readFile(filePath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("Benchmark dataset must be a non-empty JSON array");
  }

  const valid = parsed.filter((item): item is BenchmarkCase => (
    Boolean(item) && typeof item === "object"
    && typeof (item as BenchmarkCase).id === "string"
    && typeof (item as BenchmarkCase).nl_question === "string"
    && typeof (item as BenchmarkCase).oracle_sql === "string"
  ));
  if (valid.length === 0) {
    throw new Error("Benchmark dataset does not include valid cases");
  }

  return BENCHMARK_MAX_CASES > 0 ? valid.slice(0, BENCHMARK_MAX_CASES) : valid;
}

async function requestJson<T = unknown>(method: string, pathname: string, body?: unknown): Promise<RequestJsonResult<T>> {
  const url = `${APP_BASE_URL}${pathname}`;
  const init: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json"
    }
  };

  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  const response = await fetch(url, init);
  const text = await response.text();

  let payload: T | null = null;
  if (text) {
    try {
      payload = JSON.parse(text) as T;
    } catch {
      payload = { raw: text } as unknown as T;
    }
  }

  return {
    ok: response.ok,
    status: response.status,
    payload
  };
}

interface DataSourceListItem {
  id: string;
  name: string;
}

async function ensureDataSourceId(): Promise<string> {
  if (BENCHMARK_DATA_SOURCE_ID) {
    return BENCHMARK_DATA_SOURCE_ID;
  }

  const listResponse = await requestJson<{ items?: DataSourceListItem[] }>("GET", "/v1/data-sources");
  if (listResponse.ok && Array.isArray(listResponse.payload?.items)) {
    const found = listResponse.payload!.items!.find((item) => item.name === BENCHMARK_DATA_SOURCE_NAME);
    if (found?.id) {
      return found.id;
    }
  }

  const createResponse = await requestJson<{ id: string }>("POST", "/v1/data-sources", {
    name: BENCHMARK_DATA_SOURCE_NAME,
    db_type: "postgres",
    connection_ref: BENCHMARK_CONNECTION_REF
  });

  if (!createResponse.ok || !createResponse.payload) {
    throw new Error(`Failed to create data source: HTTP ${createResponse.status} ${stringifyPayload(createResponse.payload)}`);
  }

  return createResponse.payload.id;
}

interface SchemaObjectListItem {
  id: string;
  schema_name: string;
  object_name: string;
}

async function ensureIntrospectionReady(dataSourceId: string): Promise<SchemaObjectListItem[]> {
  const introspectResponse = await requestJson("POST", `/v1/data-sources/${encodeURIComponent(dataSourceId)}/introspect`);
  if (![200, 202].includes(introspectResponse.status)) {
    throw new Error(
      `Failed to trigger introspection: HTTP ${introspectResponse.status} ${stringifyPayload(introspectResponse.payload)}`
    );
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < BENCHMARK_INTROSPECTION_TIMEOUT_MS) {
    const listObjectsResponse = await requestJson<{ items?: SchemaObjectListItem[] }>(
      "GET",
      `/v1/schema-objects?data_source_id=${encodeURIComponent(dataSourceId)}`
    );

    if (
      listObjectsResponse.ok
      && Array.isArray(listObjectsResponse.payload?.items)
      && listObjectsResponse.payload!.items!.length > 0
    ) {
      return listObjectsResponse.payload!.items!;
    }

    await sleep(2000);
  }

  throw new Error(`Timed out waiting for schema introspection after ${BENCHMARK_INTROSPECTION_TIMEOUT_MS}ms`);
}

interface SessionResponse {
  session_id?: string;
}

interface RunResponse {
  sql?: string;
  rows?: Array<Record<string, unknown>>;
  provider?: string;
}

interface RunBody {
  max_rows: number;
  timeout_ms: number;
  llm_provider?: string;
  model?: string;
}

async function runCase(caseDef: BenchmarkCase, context: RunContext): Promise<CaseResult> {
  const sessionResponse = await requestJson<SessionResponse>("POST", "/v1/query/sessions", {
    data_source_id: context.dataSourceId,
    question: caseDef.nl_question
  });

  if (!sessionResponse.ok) {
    return {
      id: caseDef.id,
      question: caseDef.nl_question,
      run_status: sessionResponse.status,
      error: `create_session_failed: ${stringifyPayload(sessionResponse.payload)}`,
      correct: false,
      critical_safety_violation: false,
      e2e_latency_ms: null
    };
  }

  const sessionId = sessionResponse.payload?.session_id;
  if (!sessionId) {
    return {
      id: caseDef.id,
      question: caseDef.nl_question,
      run_status: 500,
      error: "create_session_failed: missing session_id",
      correct: false,
      critical_safety_violation: false,
      e2e_latency_ms: null
    };
  }

  const runBody: RunBody = {
    max_rows: Number.isFinite(BENCHMARK_MAX_ROWS) ? BENCHMARK_MAX_ROWS : 2000,
    timeout_ms: Number.isFinite(BENCHMARK_TIMEOUT_MS) ? BENCHMARK_TIMEOUT_MS : 30000
  };
  if (BENCHMARK_PROVIDER) {
    runBody.llm_provider = BENCHMARK_PROVIDER;
  }
  if (BENCHMARK_MODEL) {
    runBody.model = BENCHMARK_MODEL;
  }

  const runStartedAt = Date.now();
  const runResponse = await requestJson<RunResponse>("POST", `/v1/query/sessions/${encodeURIComponent(sessionId)}/run`, runBody);
  const e2eLatencyMs = Date.now() - runStartedAt;

  if (!runResponse.ok) {
    return {
      id: caseDef.id,
      question: caseDef.nl_question,
      run_status: runResponse.status,
      error: stringifyPayload(runResponse.payload),
      correct: false,
      critical_safety_violation: false,
      e2e_latency_ms: e2eLatencyMs,
      generated_sql: runResponse.payload?.sql || null
    };
  }

  const generatedSql = String(runResponse.payload?.sql || "");
  const generatedRows = Array.isArray(runResponse.payload?.rows) ? runResponse.payload!.rows! : [];

  let oracleRows: Array<Record<string, unknown>>;
  try {
    const oracleResult = await context.targetClient.query(caseDef.oracle_sql);
    oracleRows = Array.isArray(oracleResult.rows) ? oracleResult.rows : [];
  } catch (err) {
    return {
      id: caseDef.id,
      question: caseDef.nl_question,
      run_status: 500,
      error: `oracle_sql_failed: ${errorMessage(err)}`,
      correct: false,
      critical_safety_violation: false,
      e2e_latency_ms: e2eLatencyMs,
      generated_sql: generatedSql
    };
  }

  const assertion = String(caseDef.result_assertion || "row_set_equivalent");
  const evaluation = evaluateAssertion(assertion, generatedRows, oracleRows);

  return {
    id: caseDef.id,
    question: caseDef.nl_question,
    run_status: runResponse.status,
    error: null,
    correct: evaluation.ok,
    mismatch_reason: evaluation.reason,
    critical_safety_violation: detectCriticalSafetyViolation(generatedSql),
    e2e_latency_ms: e2eLatencyMs,
    generated_sql: generatedSql,
    provider: runResponse.payload?.provider || null,
    row_count_generated: generatedRows.length,
    row_count_oracle: oracleRows.length
  };
}

function evaluateAssertion(
  assertion: string,
  generatedRows: Array<Record<string, unknown>>,
  oracleRows: Array<Record<string, unknown>>
): AssertionOutcome {
  if (assertion === "single_value_equal") {
    const generatedValue = firstScalar(generatedRows);
    const oracleValue = firstScalar(oracleRows);
    if (valuesEqual(generatedValue, oracleValue)) {
      return { ok: true, reason: null };
    }
    return {
      ok: false,
      reason: `single_value_mismatch: generated=${JSON.stringify(generatedValue)} oracle=${JSON.stringify(oracleValue)}`
    };
  }

  if (assertion === "non_empty") {
    return {
      ok: generatedRows.length > 0,
      reason: generatedRows.length > 0 ? null : "generated_result_is_empty"
    };
  }

  const generatedSet = canonicalizeRows(generatedRows);
  const oracleSet = canonicalizeRows(oracleRows);

  if (generatedSet.length !== oracleSet.length) {
    return {
      ok: false,
      reason: `row_count_mismatch: generated=${generatedSet.length} oracle=${oracleSet.length}`
    };
  }

  for (let i = 0; i < generatedSet.length; i += 1) {
    if (generatedSet[i] !== oracleSet[i]) {
      return {
        ok: false,
        reason: `row_set_mismatch_at_index_${i}`
      };
    }
  }

  return { ok: true, reason: null };
}

function firstScalar(rows: Array<Record<string, unknown>>): unknown {
  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }
  const firstRow = rows[0];
  if (!firstRow || typeof firstRow !== "object") {
    return null;
  }
  const values = Object.values(firstRow);
  return values.length > 0 ? normalizeScalar(values[0]) : null;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") {
    return Math.abs(a - b) <= 0.000001;
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

function canonicalizeRows(rows: Array<Record<string, unknown>>): string[] {
  if (!Array.isArray(rows)) {
    return [];
  }

  return rows
    .map((row) => {
      const tuple = Array.isArray(row) ? row : Object.values(row || {});
      return JSON.stringify(tuple.map(normalizeScalar));
    })
    .sort();
}

function normalizeScalar(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Buffer.isBuffer(value)) {
    return value.toString("base64");
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeScalar(item));
  }
  if (typeof value === "number") {
    return Number(value.toFixed(8));
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      return Number(Number(trimmed).toFixed(8));
    }
    return trimmed;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const obj: Record<string, unknown> = {};
    for (const key of keys) {
      obj[key] = normalizeScalar((value as Record<string, unknown>)[key]);
    }
    return obj;
  }
  return value;
}

function detectCriticalSafetyViolation(sql: string): boolean {
  const source = String(sql || "").toUpperCase();
  return BLOCKED_SQL_KEYWORDS.some((keyword) => {
    const pattern = new RegExp(`\\b${keyword}\\b`, "i");
    return pattern.test(source);
  });
}

interface BenchmarkSummary {
  total_cases: number;
  sql_valid_cases: number;
  correct_cases: number;
  critical_safety_violations: number;
  correctness_rate: number;
  sql_validation_pass_rate: number;
  p95_latency_ms: number | null;
  p50_latency_ms: number | null;
  average_latency_ms: number | null;
  release_gates: {
    correctness_ge_85pct: boolean;
    critical_safety_violations_eq_0: boolean;
    p95_latency_le_8s: boolean;
    sql_validation_pass_rate_ge_98pct: boolean;
    all_passed: boolean;
  };
}

function summarizeResults(results: CaseResult[]): BenchmarkSummary {
  const total = results.length;
  const sqlValid = results.filter((item) => item.run_status === 200).length;
  const correct = results.filter((item) => item.correct).length;
  const safetyViolations = results.filter((item) => item.critical_safety_violation).length;
  const latencies = results
    .map((item) => item.e2e_latency_ms)
    .filter((value): value is number => Number.isFinite(value));

  const correctnessRate = ratio(correct, total);
  const sqlValidityRate = ratio(sqlValid, total);
  const p95Latency = percentile(latencies, 0.95);
  const p50Latency = percentile(latencies, 0.5);

  const gates = {
    correctness_ge_85pct: correctnessRate >= 0.85,
    critical_safety_violations_eq_0: safetyViolations === 0,
    p95_latency_le_8s: Number.isFinite(p95Latency) ? p95Latency <= 8000 : false,
    sql_validation_pass_rate_ge_98pct: sqlValidityRate >= 0.98
  };

  return {
    total_cases: total,
    sql_valid_cases: sqlValid,
    correct_cases: correct,
    critical_safety_violations: safetyViolations,
    correctness_rate: round4(correctnessRate),
    sql_validation_pass_rate: round4(sqlValidityRate),
    p95_latency_ms: Number.isFinite(p95Latency) ? Math.round(p95Latency) : null,
    p50_latency_ms: Number.isFinite(p50Latency) ? Math.round(p50Latency) : null,
    average_latency_ms: latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
    release_gates: {
      ...gates,
      all_passed: Object.values(gates).every(Boolean)
    }
  };
}

function ratio(numerator: number, denominator: number): number {
  if (!denominator) {
    return 0;
  }
  return numerator / denominator;
}

function round4(value: number): number {
  return Number(Number(value || 0).toFixed(4));
}

function percentile(values: number[], p: number): number {
  if (!Array.isArray(values) || values.length === 0) {
    return NaN;
  }

  const sorted = values.slice().sort((a, b) => a - b);
  const rank = Math.ceil(p * sorted.length) - 1;
  const idx = Math.max(0, Math.min(sorted.length - 1, rank));
  return sorted[idx];
}

async function fetchObservabilityMetrics(): Promise<unknown> {
  const response = await requestJson("GET", "/v1/observability/metrics");
  if (!response.ok) {
    return {
      error: `metrics_endpoint_failed: HTTP ${response.status}`
    };
  }
  return response.payload;
}

interface BenchmarkReport {
  run_date: string;
  dataset_file: string;
  data_source_id: string;
  provider: string | null;
  model: string | null;
  summary: BenchmarkSummary;
  observability: unknown;
  cases: CaseResult[];
}

interface PublishResult {
  ok: boolean;
  status?: number;
  payload?: unknown;
  error?: string;
}

async function publishBenchmarkReport(report: BenchmarkReport): Promise<PublishResult> {
  const response = await requestJson<{ id: string }>("POST", "/v1/observability/release-gates/report", report);
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      payload: response.payload
    };
  }
  return {
    ok: true,
    payload: response.payload
  };
}

function buildMarkdownReport(payload: BenchmarkReport): string {
  const summary = payload.summary;
  const gates = summary.release_gates;
  const topFailures = payload.cases
    .filter((item) => !item.correct)
    .slice(0, 10)
    .map((item) => `- ${item.id}: ${item.mismatch_reason || item.error || "incorrect"}`)
    .join("\n");

  return [
    "# MVP Benchmark Report",
    "",
    `- Run date: ${payload.run_date}`,
    `- Dataset: ${payload.dataset_file}`,
    `- Cases executed: ${summary.total_cases}`,
    `- Data source id: ${payload.data_source_id}`,
    `- Provider override: ${payload.provider || "(none)"}`,
    `- Model override: ${payload.model || "(none)"}`,
    "",
    "## Results",
    `- Correctness: ${(summary.correctness_rate * 100).toFixed(2)}%`,
    `- SQL validation pass rate: ${(summary.sql_validation_pass_rate * 100).toFixed(2)}%`,
    `- Critical safety violations: ${summary.critical_safety_violations}`,
    `- P95 latency: ${summary.p95_latency_ms === null ? "n/a" : `${summary.p95_latency_ms} ms`}`,
    `- P50 latency: ${summary.p50_latency_ms === null ? "n/a" : `${summary.p50_latency_ms} ms`}`,
    `- Average latency: ${summary.average_latency_ms === null ? "n/a" : `${summary.average_latency_ms} ms`}`,
    "",
    "## Release Gates",
    `- Correctness >= 85%: ${gateMark(gates.correctness_ge_85pct)}`,
    `- Critical safety violations = 0: ${gateMark(gates.critical_safety_violations_eq_0)}`,
    `- P95 latency <= 8s: ${gateMark(gates.p95_latency_le_8s)}`,
    `- SQL validation pass rate >= 98%: ${gateMark(gates.sql_validation_pass_rate_ge_98pct)}`,
    `- All gates passed: ${gateMark(gates.all_passed)}`,
    "",
    "## Observability Snapshot",
    payload.observability ? `\n\`\`\`json\n${JSON.stringify(payload.observability, null, 2)}\n\`\`\`` : "- unavailable",
    "",
    "## Top Failures",
    topFailures || "- none"
  ].join("\n");
}

function gateMark(ok: boolean): string {
  return ok ? "PASS" : "FAIL";
}

function stringifyPayload(payload: unknown): string {
  if (payload === null || payload === undefined) {
    return "";
  }
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

function timestampForFile(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(
    date.getUTCMinutes()
  )}${pad(date.getUTCSeconds())}`;
}

async function main(): Promise<void> {
  const cases = await readCases(BENCHMARK_FILE);
  const dataSourceId = await ensureDataSourceId();
  await ensureIntrospectionReady(dataSourceId);

  const targetClient = new Client({ connectionString: BENCHMARK_ORACLE_CONN });
  await targetClient.connect();

  const context: RunContext = {
    dataSourceId,
    targetClient
  };

  const runDate = new Date().toISOString();
  const results: CaseResult[] = [];

  try {
    for (const caseDef of cases) {
      console.log(`[benchmark] Running ${caseDef.id}: ${caseDef.nl_question}`);
      const result = await runCase(caseDef, context);
      results.push(result);
      console.log(
        `[benchmark] ${caseDef.id} status=${result.run_status} correct=${result.correct} latency_ms=${result.e2e_latency_ms ?? "n/a"}`
      );
    }
  } finally {
    await targetClient.end();
  }

  const summary = summarizeResults(results);
  const observability = await fetchObservabilityMetrics().catch((err: unknown) => ({ error: errorMessage(err) }));

  const report: BenchmarkReport = {
    run_date: runDate,
    dataset_file: BENCHMARK_FILE,
    data_source_id: dataSourceId,
    provider: BENCHMARK_PROVIDER || null,
    model: BENCHMARK_MODEL || null,
    summary,
    observability,
    cases: results
  };

  await fs.mkdir(BENCHMARK_REPORT_DIR, { recursive: true });
  const suffix = timestampForFile(new Date());
  const jsonPath = path.join(BENCHMARK_REPORT_DIR, `mvp-benchmark-${suffix}.json`);
  const markdownPath = path.join(BENCHMARK_REPORT_DIR, `mvp-benchmark-${suffix}.md`);

  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(markdownPath, `${buildMarkdownReport(report)}\n`, "utf8");

  const publishResult = await publishBenchmarkReport(report).catch((err: unknown) => ({ ok: false, error: errorMessage(err) } as PublishResult));
  if (!publishResult.ok) {
    console.warn(
      `[benchmark] Could not publish report to API: ${stringifyPayload(publishResult.error || publishResult.payload)}`
    );
  } else {
    console.log(`[benchmark] Published report to API with id=${(publishResult.payload as { id?: string } | undefined)?.id}`);
  }

  console.log(`[benchmark] Report written to ${jsonPath}`);
  console.log(`[benchmark] Report written to ${markdownPath}`);
  console.log(`[benchmark] Release gates all passed: ${summary.release_gates.all_passed}`);

  if (!summary.release_gates.all_passed) {
    process.exitCode = 2;
  }
}

main().catch((err: unknown) => {
  const e = err as { stack?: string; message?: string };
  console.error(`[benchmark] Failed: ${e.stack || errorMessage(err)}`);
  process.exit(1);
});
