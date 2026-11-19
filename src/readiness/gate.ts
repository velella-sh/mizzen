import type {
  ReadinessDimension,
  ReadinessGateCheck,
  ReadinessGateOptions,
  ReadinessGateResult,
  ReadinessReport,
} from "../contracts/readiness.ts";

/** The dimensions whose failures a high average never cancels. */
const CRITICAL: readonly ReadinessDimension[] = ["verification", "permissions"];

/**
 * Applies thresholds to one report. A failed rule always fails the gate, so a strong average cannot hide a broken
 * proof or an unknown edit target; a missing dimension score fails a threshold on that dimension.
 */
export function gateReadiness(report: ReadinessReport, options: ReadinessGateOptions): ReadinessGateResult {
  const checks: ReadinessGateCheck[] = [];
  const reasons: string[] = [];

  for (const rule of report.rules) {
    if (rule.status !== "fail") continue;
    const critical = CRITICAL.includes(rule.dimension);
    reasons.push(`${critical ? "critical " : ""}${rule.code} failed`);
  }

  if (options.minOverall !== undefined) {
    const passed = report.overall !== undefined && report.overall >= options.minOverall;
    checks.push({
      target: "overall",
      minimum: options.minOverall,
      ...(report.overall === undefined ? {} : { score: report.overall }),
      passed,
    });
    if (!passed) {
      reasons.push(`overall ${report.overall === undefined ? "unknown" : report.overall.toFixed(1)} is below ${options.minOverall}`);
    }
  }

  for (const dimension of report.dimensions) {
    const minimum = options.min[dimension.dimension];
    if (minimum === undefined) continue;
    const passedScore = dimension.score !== undefined && dimension.score >= minimum;
    checks.push({
      target: dimension.dimension,
      minimum,
      ...(dimension.score === undefined ? {} : { score: dimension.score }),
      passed: passedScore,
    });
    if (!passedScore) {
      reasons.push(`${dimension.dimension} ${dimension.score === undefined ? "unknown" : dimension.score.toFixed(1)} is below ${minimum}`);
    }
  }

  if (options.onUnknown === "fail") {
    for (const rule of report.unknowns) {
      reasons.push(`${rule.code} is unknown: ${rule.reason ?? "no reason recorded"}`);
    }
  }

  return { passed: reasons.length === 0, checks, reasons };
}
