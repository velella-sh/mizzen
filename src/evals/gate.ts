/**
 * The deterministic CI gate: a report is green only when every scored case passed and no case was
 * invalidated. An `unavailable` case is named in the gate but does not fail it, because it is a
 * known gap with a recorded reason rather than a silent skip; a missing model is never treated as a
 * pass.
 */
import type { EvalCaseResult, EvalGate } from "../contracts/evals.ts";

/** Builds the gate from the scored cases. */
export function evalGate(cases: readonly EvalCaseResult[]): EvalGate {
  const scored = cases.filter((item) => item.status === "passed" || item.status === "failed").length;
  const unavailable = cases.filter((item) => item.status === "unavailable").map((item) => item.id);
  const reasons: string[] = [];
  for (const item of cases) {
    if (item.status === "failed") {
      reasons.push(`${item.id}: ${item.findings.map((finding) => finding.message).join(" ") || "did not pass"}`);
    }
    if (item.status === "invalid") {
      reasons.push(`${item.id}: ${item.findings.map((finding) => finding.message).join(" ") || "invalid run"}`);
    }
  }
  for (const id of unavailable) {
    reasons.push(`${id}: unavailable, not scored`);
  }
  return {
    passed: cases.every((item) => item.status === "passed" || item.status === "unavailable"),
    reasons,
    scored,
    unavailable,
  };
}
