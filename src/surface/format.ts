/**
 * The surface report written for people and for machines: `formatSurfaceText` prints the counts and the gaps,
 * `formatSurfaceJson` prints the versioned report or the report plus its comparison as one JSON document, both with a
 * trailing newline and a stable order.
 */
import type { SurfaceComparison, SurfaceReport } from "../contracts/surface.ts";

/** The percentage as text, or `n/a` when nothing is in scope. */
function pct(value: number | null): string {
  return value === null ? "n/a" : `${value.toFixed(2)}%`;
}

/** One area's line: `api  12 documented, 3 partial, 1 undocumented, 1 excluded (75.00%)`. */
function areaLine(report: SurfaceReport): string[] {
  return report.coverage.areas.map((row) => {
    const c = row.counts;
    return `  ${row.area.padEnd(8)} ${c.documented} documented, ${c.partial} partial, ${c.undocumented} undocumented, ${c.excluded} excluded (${pct(row.documentedPercent)})`;
  });
}

/** The text form: the totals, the rows by area, then every gap and exclusion. */
export function formatSurfaceText(report: SurfaceReport, comparison?: SurfaceComparison): string {
  const counts = report.coverage.counts;
  const lines = [
    `Surface: ${counts.total} item${counts.total === 1 ? "" : "s"}`,
    `  ${counts.documented} documented, ${counts.partial} partial, ${counts.undocumented} undocumented, ${counts.excluded} excluded (${pct(report.coverage.documentedPercent)})`,
    ...areaLine(report),
  ];
  if (report.gaps.length === 0) {
    lines.push("No gaps.");
  } else {
    lines.push("Gaps:");
    for (const gap of report.gaps) {
      lines.push(`  ${gap.area} ${gap.item} [${gap.gap}] at ${gap.source.file}:${gap.source.line} (introduced ${gap.introduced})`);
    }
  }
  if (report.exclusions.length > 0) {
    lines.push("Excluded:");
    for (const exclusion of report.exclusions) lines.push(`  ${exclusion.id}: ${exclusion.reason}`);
  }
  if (report.findings.length > 0) {
    lines.push("Findings:");
    for (const finding of report.findings) lines.push(`  ${finding.severity} ${finding.code}: ${finding.message}`);
  }
  if (comparison !== undefined) {
    lines.push(`Compared with ${comparison.baseline ?? "the baseline"}: ${comparison.changes.length} change${comparison.changes.length === 1 ? "" : "s"}`);
    for (const change of comparison.changes) {
      lines.push(`  ${change.change}: ${change.area} ${change.id}${change.from === undefined ? "" : ` ${change.from}`}${change.to === undefined ? "" : ` -> ${change.to}`}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** The machine form: the report, or `{ report, comparison }` when a baseline was given, two-space indented. */
export function formatSurfaceJson(report: SurfaceReport, comparison?: SurfaceComparison): string {
  return `${JSON.stringify(comparison === undefined ? report : { report, comparison }, null, 2)}\n`;
}
