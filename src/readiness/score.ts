import type {
  ReadinessDimensionScore,
  ReadinessRuleResult,
  ReadinessStatus,
} from "../contracts/readiness.ts";
import { RUBRIC, dimensionOf } from "./rubric.ts";
import type { RuleOutcome } from "./scan.ts";

/** The scores and rule results derived from one scan. */
export interface ReadinessScore {
  /** `pass` when every known rule passed, `fail` when any failed, `unknown` when nothing is known. */
  readonly status: ReadinessStatus;
  /** Weighted share of known dimensions, 0–100; absent when no dimension is known. */
  readonly overall?: number;
  /** One entry per dimension, in rubric order. */
  readonly dimensions: readonly ReadinessDimensionScore[];
  /** One entry per rule, in rubric order. */
  readonly rules: readonly ReadinessRuleResult[];
  /** Rules left out of the score. */
  readonly unknowns: readonly ReadinessRuleResult[];
}

/** Turns rule outcomes into per-dimension scores and an overall score. Unknown points are excluded, never counted as passes. */
export function scoreOf(outcomes: readonly RuleOutcome[]): ReadinessScore {
  const byCode = new Map(outcomes.map((outcome) => [outcome.code, outcome]));
  const rules: ReadinessRuleResult[] = RUBRIC.rules.map((rule) => {
    const outcome = byCode.get(rule.code);
    const status = outcome?.status ?? "unknown";
    return {
      code: rule.code,
      dimension: rule.dimension,
      weight: rule.weight,
      status,
      ...(outcome?.reason === undefined ? {} : { reason: outcome.reason }),
    };
  });
  const dimensions: ReadinessDimensionScore[] = RUBRIC.dimensions.map((dimension) => {
    const own = rules.filter((rule) => rule.dimension === dimension.id);
    const passed = own.filter((rule) => rule.status === "pass").length;
    const failed = own.filter((rule) => rule.status === "fail").length;
    const unknown = own.filter((rule) => rule.status === "unknown").length;
    const known = own.filter((rule) => rule.status !== "unknown");
    const knownWeight = known.reduce((sum, rule) => sum + rule.weight, 0);
    const passedWeight = known.filter((rule) => rule.status === "pass").reduce((sum, rule) => sum + rule.weight, 0);
    const status: ReadinessStatus = failed > 0 ? "fail" : known.length === 0 ? "unknown" : "pass";
    return {
      dimension: dimension.id,
      weight: dimensionOf(dimension.id).weight,
      ...(knownWeight === 0 ? {} : { score: Math.round((passedWeight / knownWeight) * 1000) / 10 }),
      status,
      passed,
      failed,
      unknown,
    };
  });
  const knownDimensions = dimensions.filter((entry) => entry.score !== undefined);
  const knownWeight = knownDimensions.reduce((sum, entry) => sum + entry.weight, 0);
  const overall =
    knownWeight === 0
      ? undefined
      : Math.round(
          (knownDimensions.reduce((sum, entry) => sum + (entry.score ?? 0) * entry.weight, 0) / knownWeight) * 10,
        ) / 10;
  const status: ReadinessStatus =
    rules.some((rule) => rule.status === "fail") ? "fail" : rules.some((rule) => rule.status !== "unknown") ? "pass" : "unknown";
  return {
    status,
    ...(overall === undefined ? {} : { overall }),
    dimensions,
    rules,
    unknowns: rules.filter((rule) => rule.status === "unknown"),
  };
}
