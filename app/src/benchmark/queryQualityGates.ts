export const MVP_QUERY_QUALITY_THRESHOLDS = {
  max_rule_based_fallback_rate: 0.1,
  min_repair_success_rate: 0.8
} as const;

export interface QueryQualityCase {
  provider?: string | null;
  repair_count?: number;
  run_status: number;
}

export interface QueryQualitySummary {
  fallback_eligible_cases: number;
  fallback_cases: number;
  fallback_rate: number;
  repair_attempted_cases: number;
  repair_succeeded_cases: number;
  repair_success_rate: number | null;
  gates: {
    fallback_rate_le_10pct: boolean;
    repair_success_rate_ge_80pct: boolean;
  };
}

export function summarizeQueryQuality(cases: QueryQualityCase[]): QueryQualitySummary {
  const successfulCases = cases.filter((item) => item.run_status === 200);
  const fallbackCases = successfulCases.filter((item) => item.provider === "local-fallback").length;
  const repairAttempts = cases.filter((item) => Number(item.repair_count || 0) > 0);
  const repairSuccesses = repairAttempts.filter((item) => item.run_status === 200).length;
  const fallbackRate = ratio(fallbackCases, successfulCases.length);
  const repairSuccessRate = repairAttempts.length > 0
    ? ratio(repairSuccesses, repairAttempts.length)
    : null;

  return {
    fallback_eligible_cases: successfulCases.length,
    fallback_cases: fallbackCases,
    fallback_rate: round4(fallbackRate),
    repair_attempted_cases: repairAttempts.length,
    repair_succeeded_cases: repairSuccesses,
    repair_success_rate: repairSuccessRate === null ? null : round4(repairSuccessRate),
    gates: {
      fallback_rate_le_10pct: fallbackRate <= MVP_QUERY_QUALITY_THRESHOLDS.max_rule_based_fallback_rate,
      repair_success_rate_ge_80pct: repairSuccessRate === null
        || repairSuccessRate >= MVP_QUERY_QUALITY_THRESHOLDS.min_repair_success_rate
    }
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function round4(value: number): number {
  return Number(value.toFixed(4));
}
