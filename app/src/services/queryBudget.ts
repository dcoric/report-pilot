export interface ExplainPlanNode {
  "Total Cost"?: number;
  "Plan Rows"?: number;
  Plans?: ExplainPlanNode[];
  [key: string]: unknown;
}

export interface ExplainBudgetMetrics {
  maxTotalCost: number;
  maxPlanRows: number;
}

export type EvaluateExplainBudgetResult =
  | { ok: true; errors: []; metrics: ExplainBudgetMetrics }
  | { ok: false; errors: string[]; metrics: ExplainBudgetMetrics | null };

export interface ExplainBudgetOptions {
  maxTotalCost?: number;
  maxPlanRows?: number;
}

function extractRootPlan(explainRows: unknown): ExplainPlanNode | null {
  if (!Array.isArray(explainRows) || explainRows.length === 0) {
    return null;
  }

  const first = explainRows[0] as Record<string, unknown> | undefined;
  if (!first) {
    return null;
  }

  const queryPlan = (first["QUERY PLAN"] || first.query_plan) as Array<{ Plan?: ExplainPlanNode }> | undefined;
  if (!Array.isArray(queryPlan) || queryPlan.length === 0) {
    return null;
  }

  return queryPlan[0]?.Plan || null;
}

function walkPlans(plan: ExplainPlanNode | null | undefined, fn: (node: ExplainPlanNode) => void): void {
  if (!plan) {
    return;
  }
  fn(plan);
  const children = Array.isArray(plan.Plans) ? plan.Plans : [];
  for (const child of children) {
    walkPlans(child, fn);
  }
}

function collectPlanMetrics(rootPlan: ExplainPlanNode): ExplainBudgetMetrics {
  const metrics: ExplainBudgetMetrics = {
    maxTotalCost: 0,
    maxPlanRows: 0
  };

  walkPlans(rootPlan, (node) => {
    const totalCost = Number(node["Total Cost"] || 0);
    const planRows = Number(node["Plan Rows"] || 0);

    if (Number.isFinite(totalCost) && totalCost > metrics.maxTotalCost) {
      metrics.maxTotalCost = totalCost;
    }
    if (Number.isFinite(planRows) && planRows > metrics.maxPlanRows) {
      metrics.maxPlanRows = planRows;
    }
  });

  return metrics;
}

export function evaluateExplainBudget(explainRows: unknown, opts: ExplainBudgetOptions = {}): EvaluateExplainBudgetResult {
  const rootPlan = extractRootPlan(explainRows);
  if (!rootPlan) {
    return {
      ok: false,
      errors: ["Could not parse EXPLAIN output"],
      metrics: null
    };
  }

  const metrics = collectPlanMetrics(rootPlan);
  const maxTotalCost = Number(opts.maxTotalCost || 500000);
  const maxPlanRows = Number(opts.maxPlanRows || 1000000);

  const errors: string[] = [];
  if (metrics.maxTotalCost > maxTotalCost) {
    errors.push(`Estimated total cost ${metrics.maxTotalCost} exceeds budget ${maxTotalCost}`);
  }
  if (metrics.maxPlanRows > maxPlanRows) {
    errors.push(`Estimated plan rows ${metrics.maxPlanRows} exceeds budget ${maxPlanRows}`);
  }

  return {
    ok: errors.length === 0,
    errors: errors as never,
    metrics
  };
}
