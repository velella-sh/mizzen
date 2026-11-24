/**
 * The behavior report written for people and for machines: `formatBehaviorText` prints the counts, the unverified
 * behaviors, and an optional drift comparison; `formatBehaviorJson` prints the versioned report, or the report and
 * comparison together. Both end with one LF and keep the report's deterministic order.
 */
import type { BehaviorComparison, BehaviorReport } from "../contracts/behavior.ts";
import { formatSpan } from "../source/spans.ts";

/** The percentage as text, or `n/a` when nothing is in scope. */
function pct(value: number, total: number): string {
  return total === 0 ? "n/a" : `${((value / total) * 100).toFixed(2)}%`;
}

/** One environment line, such as `os=linux, runtime=node>=24`. */
function environmentText(env: { readonly os?: string; readonly language?: string; readonly runtime?: string }): string {
  const parts: string[] = [];
  if (env.os !== undefined) parts.push(`os=${env.os}`);
  if (env.language !== undefined) parts.push(`language=${env.language}`);
  if (env.runtime !== undefined) parts.push(`runtime=${env.runtime}`);
  return parts.join(", ");
}

/** The text form: the totals, every unverified behavior with its reasons, the findings, and an optional comparison. */
export function formatBehaviorText(report: BehaviorReport, comparison?: BehaviorComparison): string {
  const { coverage } = report;
  const lines = [
    `Behavior contracts: ${coverage.total}`,
    `  ${coverage.verified} verified, ${coverage.unverified} unverified, ${coverage.private} private (${pct(coverage.verified, coverage.total)})`,
    `  supported ${coverage.byStatus.supported}, experimental ${coverage.byStatus.experimental}, deprecated ${coverage.byStatus.deprecated}, removed ${coverage.byStatus.removed}`,
    `  surface ${coverage.surface.linked} linked, ${coverage.surface.missing} missing`,
  ];
  const unverified = report.behaviors.filter((behavior) => behavior.verification.status === "unverified");
  if (unverified.length === 0) {
    lines.push("No unverified behavior.");
  } else {
    lines.push("Unverified:");
    for (const behavior of unverified) {
      lines.push(
        `  ${behavior.id} at ${formatSpan(behavior.source)}: ${behavior.verification.reasons.join(", ")}`,
      );
    }
  }
  if (report.findings.length > 0) {
    lines.push("Findings:");
    for (const finding of report.findings) {
      const where = finding.pos === undefined ? "" : ` at ${formatSpan(finding.pos)}`;
      lines.push(`  ${finding.severity} ${finding.code}${where}: ${finding.message}`);
    }
  }
  if (comparison !== undefined) {
    const changes = comparison.added.length + comparison.removed.length + comparison.drift.length;
    lines.push(`Compared with ${comparison.baseline ?? "the baseline"}: ${changes} change${changes === 1 ? "" : "s"}`);
    for (const id of comparison.added) lines.push(`  added: ${id}`);
    for (const id of comparison.removed) lines.push(`  removed: ${id}`);
    for (const drift of comparison.drift) {
      lines.push(`  drift: ${drift.behavior} [${drift.kinds.join(", ")}] at ${formatSpan(drift.documentation.source)}`);
      for (const test of drift.tests.after) {
        const name = test.name === undefined ? "" : ` "${test.name}"`;
        lines.push(`    test ${test.file}${name}: ${test.outcome} (${test.state})`);
      }
      for (const surface of drift.surface.after) {
        const signature = surface.signature === undefined ? "" : ` ${surface.signature}`;
        lines.push(`    surface ${surface.item}: ${surface.state}${signature}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

/** The machine form: the report, or `{ report, comparison }` when a baseline was given, two-space indented. */
export function formatBehaviorJson(report: BehaviorReport, comparison?: BehaviorComparison): string {
  return `${JSON.stringify(comparison === undefined ? report : { report, comparison }, null, 2)}\n`;
}

/** One environment as the matrix prints it; empty means the behavior applies everywhere. */
export function environmentListText(environments: readonly { readonly os?: string; readonly language?: string; readonly runtime?: string }[]): string {
  if (environments.length === 0) return "all";
  return environments.map(environmentText).join("; ");
}
