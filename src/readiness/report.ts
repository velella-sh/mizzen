import { createHash } from "node:crypto";
import { canonicalJson } from "../data/lock.ts";
import { version } from "../index.ts";
import type {
  ReadinessEvaluationState,
  ReadinessReport,
} from "../contracts/readiness.ts";
import { RUBRIC } from "./rubric.ts";
import { scoreOf } from "./score.ts";
import type { ScanResult } from "./scan.ts";

/** The JSON Schema that describes every report this module writes. */
export const REPORT_SCHEMA = "https://github.com/velella-sh/mizzen/schema/readiness-report.schema.json" as const;

/** Options of {@link readinessReport}. */
export interface ReportOptions {
  /** A link to CI evidence for this build, kept only when it is a public http(s) URL. */
  readonly evidence?: string;
  /** How the evaluation step came out; defaults to an honest unknown. */
  readonly evaluations?: ReadinessEvaluationState;
}

/** SHA-256 over the canonical report with its digest left out. */
export function readinessDigest(report: Omit<ReadinessReport, "digest"> | ReadinessReport): string {
  const { digest: _digest, ...rest } = report as ReadinessReport;
  return createHash("sha256").update(canonicalJson(rest)).digest("hex");
}

/** An evidence link is public when it is http(s); anything else is dropped rather than published. */
function publicEvidence(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Builds the versioned report from one scan. Findings are already sorted; the digest covers everything else. */
export function readinessReport(scan: ScanResult, options: ReportOptions = {}): ReadinessReport {
  const score = scoreOf(scan.outcomes);
  const evidence = publicEvidence(options.evidence);
  const report: Omit<ReadinessReport, "digest"> = {
    version: 1,
    schema: REPORT_SCHEMA,
    rubric: { version: RUBRIC.version },
    engine: version,
    build: scan.build,
    status: score.status,
    ...(score.overall === undefined ? {} : { overall: score.overall }),
    dimensions: score.dimensions,
    rules: score.rules,
    findings: scan.findings,
    unknowns: score.unknowns,
    evaluations:
      options.evaluations ?? {
        status: "unknown",
        reason: "no evaluation report was supplied",
      },
    ...(evidence === undefined ? {} : { evidence }),
    privacy: { public: true, redacted: 0 },
  };
  return { ...report, digest: readinessDigest(report) };
}

/** True when a report is structurally usable and its digest matches its content. */
export function verifyReadinessReport(value: unknown): value is ReadinessReport {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const report = value as ReadinessReport;
  if (report.version !== 1 || report.schema !== REPORT_SCHEMA) return false;
  if (typeof report.digest !== "string" || !/^[0-9a-f]{64}$/.test(report.digest)) return false;
  if (typeof report.build?.hash !== "string" || !/^[0-9a-f]{64}$/.test(report.build.hash)) return false;
  if (!Array.isArray(report.findings) || !Array.isArray(report.dimensions) || !Array.isArray(report.rules)) return false;
  return readinessDigest(report) === report.digest;
}

/** One decimal score, or `unknown`. */
function scoreText(score: number | undefined): string {
  return score === undefined ? "unknown" : score.toFixed(1);
}

/** The human report. It names rules, statuses, subscores, unknowns, and remediations, and carries no page text. */
export function formatReadiness(report: ReadinessReport): string {
  const lines: string[] = [
    `Mizzen readiness ${report.rubric.version} · build ${report.build.hash.slice(0, 12)} · ${report.build.pages} page(s), ${report.build.files} file(s)`,
    `Status: ${report.status} · overall ${report.overall === undefined ? "unknown" : report.overall.toFixed(1)}`,
    "",
  ];
  for (const dimension of report.dimensions) {
    lines.push(
      `${dimension.dimension.padEnd(14)} ${scoreText(dimension.score).padStart(6)}  ${dimension.status.padEnd(7)} ${dimension.passed} passed, ${dimension.failed} failed, ${dimension.unknown} unknown`,
    );
  }
  lines.push("");
  if (report.findings.length === 0) {
    lines.push("Findings: none");
  } else {
    lines.push(`Findings (${report.findings.length}):`);
    for (const entry of report.findings) {
      const place = entry.scope.page === undefined ? "" : ` ${entry.scope.page}${entry.scope.block === undefined ? "" : `#${entry.scope.block}`}`;
      lines.push(`  ${entry.severity} ${entry.code}${place}: ${entry.message}`);
      lines.push(`    evidence: ${entry.evidence}`);
      lines.push(`    fix: ${entry.remediation.action}`);
    }
  }
  lines.push("");
  if (report.unknowns.length === 0) {
    lines.push("Unknown: none");
  } else {
    lines.push(`Unknown (${report.unknowns.length}):`);
    for (const rule of report.unknowns) lines.push(`  ${rule.code}: ${rule.reason ?? "unknown"}`);
  }
  lines.push("");
  lines.push(`Evaluations: ${report.evaluations.status} (${report.evaluations.reason})`);
  if (report.unknowns.length > 0 && report.evaluations.status === "unknown") {
    lines.push("An unknown is not a pass; use --fail-on-unknown to gate on it.");
  }
  lines.push(`Rubric: https://github.com/velella-sh/mizzen/blob/main/docs/readiness.md`);
  return `${lines.join("\n")}\n`;
}

/** The machine report: canonical JSON with one trailing LF, so two runs of one build agree byte for byte. */
export function formatReadinessJson(report: ReadinessReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
