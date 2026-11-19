import type { ReadinessDimension, ReadinessFinding, ReadinessReport, ReadinessStatus } from "../contracts/readiness.ts";
import { RUBRIC } from "./rubric.ts";
import { verifyReadinessReport } from "./report.ts";

/** One rule's change between two reports. */
export interface RuleChange {
  /** Stable rule code. */
  readonly code: string;
  /** The dimension the rule scores. */
  readonly dimension: ReadinessDimension;
  /** Status in the earlier report, absent when the rule did not exist there. */
  readonly before?: ReadinessStatus;
  /** Status in the later report, absent when the rule does not exist there. */
  readonly after?: ReadinessStatus;
  /** `improved`, `regressed`, `unchanged`, `appeared`, or `disappeared`. */
  readonly change: "improved" | "regressed" | "unchanged" | "appeared" | "disappeared";
  /** Why the later status is what it is, when the report records a reason. */
  readonly reason?: string;
}

/** One page's finding delta. */
export interface PageChange {
  /** Output URL of the page. */
  readonly page: string;
  /** Findings in the earlier report. */
  readonly before: number;
  /** Findings in the later report. */
  readonly after: number;
  /** Codes that appeared, sorted. */
  readonly added: readonly string[];
  /** Codes that were resolved, sorted. */
  readonly resolved: readonly string[];
}

/** A stable comparison of two readiness reports. */
export interface ReadinessComparison {
  /** The earlier build's hash and rubric version. */
  readonly before: { readonly build: string; readonly rubric: string; readonly overall?: number };
  /** The later build's hash and rubric version. */
  readonly after: { readonly build: string; readonly rubric: string; readonly overall?: number };
  /** True when the two reports scored against different rubric versions. */
  readonly rubricChanged: boolean;
  /** Overall score change, when both reports have one. */
  readonly overallDelta?: number;
  /** One entry per rubric dimension, in rubric order. */
  readonly dimensions: readonly {
    readonly dimension: ReadinessDimension;
    readonly before?: number;
    readonly after?: number;
    readonly delta?: number;
  }[];
  /** Rule changes, in rubric order. */
  readonly rules: readonly RuleChange[];
  /** Page deltas for pages whose findings changed, sorted by URL. */
  readonly pages: readonly PageChange[];
}

/** Thrown when a report cannot be verified; a comparison never guesses from an unverified artifact. */
export class ReadinessCompareError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadinessCompareError";
  }
}

const RANK: Readonly<Record<ReadinessStatus, number>> = { fail: 0, unknown: 1, pass: 2 };

/** Reads a report from parsed JSON and proves its digest before comparing it. */
export function checkedReport(value: unknown, label: string): ReadinessReport {
  if (!verifyReadinessReport(value)) {
    throw new ReadinessCompareError(`${label} is not a verified readiness report: its digest does not match its content.`);
  }
  return value;
}

/** Findings of one report grouped by page URL, ignoring site findings. */
function pageFindings(report: ReadinessReport): Map<string, readonly ReadinessFinding[]> {
  const map = new Map<string, ReadinessFinding[]>();
  for (const finding of report.findings) {
    const page = finding.scope.page;
    if (page === undefined) continue;
    const list = map.get(page) ?? [];
    list.push(finding);
    map.set(page, list);
  }
  return map;
}

/** Compares two verified reports, by dimension, rule, and page. Ordering is code-point order, never input order. */
export function compareReadiness(before: ReadinessReport, after: ReadinessReport): ReadinessComparison {
  const ruleBefore = new Map(before.rules.map((rule) => [rule.code, rule]));
  const ruleAfter = new Map(after.rules.map((rule) => [rule.code, rule]));
  const codes = new Set([...ruleBefore.keys(), ...ruleAfter.keys()]);
  const rules: RuleChange[] = [...codes].sort().map((code) => {
    const first = ruleBefore.get(code);
    const second = ruleAfter.get(code);
    if (first === undefined) return { code, dimension: second!.dimension, after: second!.status, change: "appeared", ...(second!.reason === undefined ? {} : { reason: second!.reason }) };
    if (second === undefined) return { code, dimension: first.dimension, before: first.status, change: "disappeared" };
    const delta = RANK[second.status] - RANK[first.status];
    return {
      code,
      dimension: second.dimension,
      before: first.status,
      after: second.status,
      change: delta > 0 ? "improved" : delta < 0 ? "regressed" : "unchanged",
      ...(second.reason === undefined ? {} : { reason: second.reason }),
    };
  });

  const beforePages = pageFindings(before);
  const afterPages = pageFindings(after);
  const pageUrls = new Set([...beforePages.keys(), ...afterPages.keys()]);
  const pages: PageChange[] = [...pageUrls]
    .sort()
    .map((page) => {
      const first = beforePages.get(page) ?? [];
      const second = afterPages.get(page) ?? [];
      const firstCodes = new Set(first.map((entry) => entry.code));
      const secondCodes = new Set(second.map((entry) => entry.code));
      return {
        page,
        before: first.length,
        after: second.length,
        added: [...secondCodes].filter((code) => !firstCodes.has(code)).sort(),
        resolved: [...firstCodes].filter((code) => !secondCodes.has(code)).sort(),
      };
    })
    .filter((entry) => entry.added.length > 0 || entry.resolved.length > 0 || entry.before !== entry.after);

  const dimensionIds = new Set<ReadinessDimension>(RUBRIC.dimensions.map((dimension) => dimension.id));
  const firstDimension = new Map(before.dimensions.map((entry) => [entry.dimension, entry.score]));
  const secondDimension = new Map(after.dimensions.map((entry) => [entry.dimension, entry.score]));
  const dimensions = RUBRIC.dimensions
    .filter((dimension) => dimensionIds.has(dimension.id))
    .map((dimension) => {
      const first = firstDimension.get(dimension.id);
      const second = secondDimension.get(dimension.id);
      return {
        dimension: dimension.id,
        ...(first === undefined ? {} : { before: first }),
        ...(second === undefined ? {} : { after: second }),
        ...(first === undefined || second === undefined ? {} : { delta: Math.round((second - first) * 10) / 10 }),
      };
    });

  return {
    before: {
      build: before.build.hash,
      rubric: before.rubric.version,
      ...(before.overall === undefined ? {} : { overall: before.overall }),
    },
    after: {
      build: after.build.hash,
      rubric: after.rubric.version,
      ...(after.overall === undefined ? {} : { overall: after.overall }),
    },
    rubricChanged: before.rubric.version !== after.rubric.version,
    ...(before.overall === undefined || after.overall === undefined
      ? {}
      : { overallDelta: Math.round((after.overall - before.overall) * 10) / 10 }),
    dimensions,
    rules,
    pages,
  };
}

/** A deterministic text comparison that names the snapshots, every change, and any rubric version difference. */
export function formatComparison(comparison: ReadinessComparison): string {
  const score = (value: number | undefined): string => (value === undefined ? "unknown" : value.toFixed(1));
  const lines: string[] = [
    `before ${comparison.before.build} (rubric ${comparison.before.rubric}) · overall ${score(comparison.before.overall)}`,
    `after  ${comparison.after.build} (rubric ${comparison.after.rubric}) · overall ${score(comparison.after.overall)}`,
  ];
  if (comparison.rubricChanged) {
    lines.push(`Rubric changed: ${comparison.before.rubric} -> ${comparison.after.rubric}; results are not directly comparable.`);
  }
  if (comparison.overallDelta !== undefined) {
    const sign = comparison.overallDelta > 0 ? "+" : "";
    lines.push(`Overall change: ${sign}${comparison.overallDelta.toFixed(1)}`);
  }
  lines.push("");
  for (const dimension of comparison.dimensions) {
    const delta = dimension.delta === undefined ? "" : ` (${dimension.delta > 0 ? "+" : ""}${dimension.delta.toFixed(1)})`;
    lines.push(`${dimension.dimension.padEnd(14)} ${score(dimension.before).padStart(7)} -> ${score(dimension.after).padStart(7)}${delta}`);
  }
  const changedRules = comparison.rules.filter((rule) => rule.change !== "unchanged");
  lines.push("");
  lines.push(`Rules: ${changedRules.length} change(s)`);
  for (const rule of changedRules) {
    lines.push(`  ${rule.change} ${rule.code}: ${rule.before ?? "absent"} -> ${rule.after ?? "absent"}${rule.reason === undefined ? "" : ` (${rule.reason})`}`);
  }
  lines.push(`Pages: ${comparison.pages.length} change(s)`);
  for (const page of comparison.pages) {
    lines.push(`  ${page.page}: ${page.before} -> ${page.after} finding(s)`);
    for (const code of page.added) lines.push(`    + ${code}`);
    for (const code of page.resolved) lines.push(`    - ${code}`);
  }
  return `${lines.join("\n")}\n`;
}
