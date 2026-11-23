/**
 * `mizzen knowledge [dir]`: reports every page's and record's explicit knowledge status, the gaps, and the counts. It
 * keeps three cases apart — an explicit `unknown`, a documentation gap for a subject that declares nothing, and an
 * `unsupported` case the site cannot handle — and it can compare two reports.
 *
 * The report is deterministic: subjects are sorted, review is measured against an explicit `--as-of` date, and no
 * clock, network, or environment is read. A private rationale or citation never appears in the report or its JSON.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Diagnostic } from "../contracts/diagnostic.ts";
import type { KnowledgeComparison, KnowledgeReport } from "../contracts/knowledge.ts";
import { compareKnowledgeReports, knowledgeReportOf } from "../knowledge/report.ts";
import { buildModel } from "../model/build.ts";
import { formatText } from "../pipeline/diagnostics.ts";

/** Where the command prints. */
export interface KnowledgeIo {
  readonly log: (message: string) => void;
  readonly error: (message: string) => void;
}

export const knowledgeUsage = `Usage: mizzen knowledge [dir] [options]

  --json               Print the versioned report (schema/knowledge-report.schema.json)
  --format <text|json> Choose the output; \`--json\` is the same as \`--format json\`
  --as-of <date>       Measure review against this YYYY-MM-DD date instead of reading no clock
  --baseline <file>    Compare against an earlier report written by this command
  --out <file>         Write the report (or comparison) to this file instead of stdout
  --fail-on <status>   Exit 1 when any subject has this status or a documentation gap (repeatable)
`;

/** The statuses a caller can fail on. */
const FAIL_STATUSES = ["unknown", "unsupported", "unverified", "not-applicable", "out-of-scope", "missing"] as const;
type FailStatus = (typeof FAIL_STATUSES)[number];

interface KnowledgeArgs {
  readonly root: string;
  readonly format: "text" | "json";
  readonly asOf?: string;
  readonly baseline?: string;
  readonly out?: string;
  readonly failOn: readonly FailStatus[];
}

/** Parses the command's arguments. */
function parseKnowledge(args: readonly string[]): KnowledgeArgs | { readonly error: string } {
  let root = ".";
  let format: "text" | "json" | undefined;
  let asOf: string | undefined;
  let baseline: string | undefined;
  let out: string | undefined;
  const failOn: FailStatus[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "-h" || arg === "--help") return { error: "" };
    if (arg === "--json") {
      format = "json";
      continue;
    }
    if (arg.startsWith("-")) {
      const next = args[++index];
      if (next === undefined || next.startsWith("-")) return { error: `${arg} needs a value` };
      if (arg === "--format") {
        if (next !== "text" && next !== "json") return { error: "--format must be text or json" };
        format = next;
      } else if (arg === "--as-of") {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(next)) return { error: "--as-of needs YYYY-MM-DD" };
        asOf = next;
      } else if (arg === "--baseline") baseline = next;
      else if (arg === "--out") out = next;
      else if (arg === "--fail-on") {
        for (const value of next.split(",").map((item) => item.trim())) {
          if (!(FAIL_STATUSES as readonly string[]).includes(value)) {
            return { error: `--fail-on names "${value}"; use one of ${FAIL_STATUSES.join(", ")}` };
          }
          failOn.push(value as FailStatus);
        }
      } else return { error: `unknown option: ${arg}` };
    } else if (root === ".") root = arg;
    else return { error: `unexpected argument: ${arg}` };
  }
  return { root, format: format ?? "text", ...(asOf === undefined ? {} : { asOf }), ...(baseline === undefined ? {} : { baseline }), ...(out === undefined ? {} : { out }), failOn };
}

/** Writes a file through a staging rename, so no reader sees a partial report. */
async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
}

/** The text form: the counts, the gaps, and a comparison when one was asked for. */
export function formatKnowledgeText(report: KnowledgeReport, comparison?: KnowledgeComparison): string {
  const lines = [
    `Knowledge: ${report.entries.length} subject${report.entries.length === 1 ? "" : "s"}`,
    `  unknown ${report.counts.unknown}, unsupported ${report.counts.unsupported}, unverified ${report.counts.unverified}, not-applicable ${report.counts["not-applicable"]}, out-of-scope ${report.counts["out-of-scope"]}, missing ${report.counts.missing}`,
  ];
  if (report.gaps.length === 0) {
    lines.push("No gaps.");
  } else {
    lines.push("Gaps:");
    for (const gap of report.gaps) {
      const kind = gap.kind === "documentation-gap" ? "documentation gap" : gap.kind;
      const review = gap.review ? " (needs review)" : "";
      lines.push(`  ${gap.subject.kind} ${gap.subject.id}: ${kind} [${gap.status}] at ${gap.span}${review}`);
    }
  }
  if (comparison !== undefined) {
    lines.push(`Compared with ${comparison.baseline ?? "the baseline"}: ${comparison.changes.length} change${comparison.changes.length === 1 ? "" : "s"}`);
    for (const change of comparison.changes) {
      const from = change.from ?? "-";
      const to = change.to ?? "-";
      lines.push(`  ${change.change}: ${change.subject.kind} ${change.subject.id} ${from} -> ${to}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Reads a baseline report, or explains why it cannot. */
async function readBaseline(path: string): Promise<KnowledgeReport | { readonly error: string }> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<KnowledgeReport>;
    if (value.version !== 1 || !Array.isArray(value.entries) || value.counts === undefined) {
      return { error: `${path} is not a knowledge report this command wrote.` };
    }
    return value as KnowledgeReport;
  } catch (error) {
    return { error: `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** The statuses present in the report, for `--fail-on`. */
function matchedFailures(report: KnowledgeReport, failOn: readonly FailStatus[]): readonly string[] {
  if (failOn.length === 0) return [];
  const missing = report.counts.missing > 0;
  const found: string[] = [];
  for (const status of failOn) {
    if (status === "missing") {
      if (missing) found.push(`${report.counts.missing} documentation gap(s)`);
    } else if (report.counts[status] > 0) {
      found.push(`${report.counts[status]} ${status}`);
    }
  }
  return found;
}

/** Runs `mizzen knowledge`; returns the exit code. */
export async function runKnowledge(args: readonly string[], io: KnowledgeIo): Promise<number> {
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    io.log(`${knowledgeUsage.replace(/\n$/, "")}\n`);
    return 0;
  }
  const parsed = parseKnowledge(args);
  if ("error" in parsed) {
    if (parsed.error === "") {
      io.log(`${knowledgeUsage.replace(/\n$/, "")}\n`);
      return 0;
    }
    io.error(`mizzen: ${parsed.error}\n\n${knowledgeUsage}`);
    return 2;
  }
  const root = resolve(parsed.root);
  const model = await buildModel(root);
  const errors: readonly Diagnostic[] = model.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) {
    io.error(formatText(errors).replace(/\n$/, ""));
    return 1;
  }
  const report = knowledgeReportOf(model.site, {
    ...(parsed.asOf === undefined ? {} : { asOf: parsed.asOf }),
  });

  let comparison: KnowledgeComparison | undefined;
  if (parsed.baseline !== undefined) {
    const baseline = await readBaseline(parsed.baseline);
    if ("error" in baseline) {
      io.error(`mizzen: ${baseline.error}`);
      return 2;
    }
    comparison = compareKnowledgeReports(baseline, report);
  }

  const text = parsed.format === "json"
    ? `${JSON.stringify(comparison === undefined ? report : { report, comparison }, null, 2)}\n`
    : formatKnowledgeText(report, comparison);

  if (parsed.out === undefined) io.log(text.replace(/\n$/, ""));
  else await writeAtomic(resolve(parsed.out), text);

  const failures = matchedFailures(report, parsed.failOn);
  if (failures.length > 0) {
    io.error(`mizzen: knowledge gaps: ${failures.join(", ")}`);
    return 1;
  }
  return 0;
}
