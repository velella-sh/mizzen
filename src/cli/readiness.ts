import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ReadinessDimension, ReadinessGateOptions, ReadinessReport } from "../contracts/readiness.ts";
import { badgeMarkdown, badgeSvg } from "../readiness/badge.ts";
import { checkedReport, compareReadiness, formatComparison } from "../readiness/compare.ts";
import { readEvaluationReport } from "../readiness/evals.ts";
import { gateReadiness } from "../readiness/gate.ts";
import { formatReadiness, formatReadinessJson, readinessReport } from "../readiness/report.ts";
import { scanBuild, scanHasBuild } from "../readiness/scan.ts";
import { redactReadinessReport } from "../readiness/redact.ts";

/** The `mizzen readiness` options after parsing. */
export interface ReadinessCommandOptions {
  /** The built folder to scan. */
  readonly built: string;
  /** `text` for people, `json` for machines. */
  readonly format: "text" | "json";
  /** Write the JSON report here. */
  readonly report?: string;
  /** Write the SVG (or, for `.md`, the Markdown) badge here. */
  readonly badge?: string;
  /** A previously written report to compare with this build. */
  readonly compare?: string;
  /** A matching evaluation report. */
  readonly evals?: string;
  /** Minimum overall score. */
  readonly minOverall?: number;
  /** Minimum per dimension. */
  readonly min: Readonly<Partial<Record<ReadinessDimension, number>>>;
  /** Keep the badge committed to the build's evidence link. */
  readonly evidence?: string;
  /** Fail on any unknown rule. */
  readonly failOnUnknown: boolean;
}

/** The output sinks a command writes to. */
export interface ReadinessIo {
  readonly log: (message: string) => void;
  readonly error: (message: string) => void;
}

/** The evaluation state a report records, from the scan that consumed the report. */
function evaluationState(
  scan: Awaited<ReturnType<typeof scanBuild>>,
  evaluation: Awaited<ReturnType<typeof readEvaluationReport>>,
): ReadinessReport["evaluations"] | undefined {
  if ("problem" in evaluation) return undefined;
  const outcome = scan.outcomes.find((entry) => entry.code === "examples.evaluation");
  const status = outcome?.status ?? "unknown";
  return {
    status,
    reason: outcome?.reason ?? `suite ${evaluation.evaluation.suite} ${evaluation.evaluation.version} matched snapshot ${evaluation.evaluation.snapshot}`,
    suite: evaluation.evaluation.suite,
    version: evaluation.evaluation.version,
    snapshot: evaluation.evaluation.snapshot,
  };
}

/** Reads a previous report, which must verify before it is compared. */
async function previousReport(path: string): Promise<{ report?: ReadinessReport; problem?: string }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return { problem: `${path} is unreadable` };
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return { problem: `${path} is not valid JSON` };
  }
  try {
    return { report: checkedReport(value, path) };
  } catch (error) {
    return { problem: error instanceof Error ? error.message : String(error) };
  }
}

/** Writes one output file, making its folder first. */
async function writeFileAt(path: string, text: string): Promise<void> {
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, text);
}

/**
 * `mizzen readiness [built]`: scan one built folder against the public rubric, print the report, write a versioned
 * JSON report, write a badge from that verified report, compare with an earlier report, or gate the build. Exit 0 is a
 * pass, 1 a failed rule or threshold, and 2 a missing build, unreadable evaluation, or unverified comparison.
 */
export async function readinessCommand(options: ReadinessCommandOptions, io: ReadinessIo): Promise<number> {
  const evaluation = options.evals === undefined ? undefined : await readEvaluationReport(options.evals);
  if (evaluation !== undefined && "problem" in evaluation) {
    io.error(`readiness: ${evaluation.problem}`);
    return 2;
  }
  const scan = await scanBuild(options.built, evaluation === undefined ? {} : { evaluations: evaluation.evaluation });
  if (!scanHasBuild(scan)) {
    io.error(`readiness: ${resolve(options.built)} has no readable .mizzen/manifest.json; build the site first.`);
    return 2;
  }
  const report = redactReadinessReport(
    readinessReport(scan, {
      ...(options.evidence === undefined ? {} : { evidence: options.evidence }),
      ...(evaluation === undefined || "problem" in evaluation ? {} : { evaluations: evaluationState(scan, evaluation)! }),
    }),
  );

  if (options.report !== undefined) await writeFileAt(options.report, formatReadinessJson(report));
  if (options.badge !== undefined) {
    const badge = options.badge.endsWith(".md") ? badgeMarkdown(report) : badgeSvg(report);
    await writeFileAt(options.badge, badge);
  }

  if (options.format === "json") io.log(formatReadinessJson(report).replace(/\n$/, ""));
  else io.log(formatReadiness(report).replace(/\n$/, ""));

  if (options.compare !== undefined) {
    const previous = await previousReport(options.compare);
    if (previous.report === undefined) {
      io.error(`readiness: ${previous.problem ?? "the comparison report cannot be read"}`);
      return 2;
    }
    const comparison = compareReadiness(previous.report, report);
    io.log(options.format === "json" ? `${JSON.stringify(comparison, null, 2)}\n` : formatComparison(comparison).trimEnd());
  }

  const gateOptions: ReadinessGateOptions = {
    min: options.min,
    ...(options.minOverall === undefined ? {} : { minOverall: options.minOverall }),
    ...(options.failOnUnknown ? { onUnknown: "fail" as const } : {}),
  };
  const gated = options.minOverall !== undefined || Object.keys(options.min).length > 0 || options.failOnUnknown;
  if (gated) {
    const gate = gateReadiness(report, gateOptions);
    if (!gate.passed) {
      for (const reason of gate.reasons) io.error(`readiness: ${reason}`);
      return 1;
    }
  }
  return report.status === "fail" ? 1 : 0;
}
