/**
 * `mizzen behavior [dir]`: report product behavior contracts, link each one to its public surface, tests, and evidence,
 * and reach a verified or unverified verdict from the evidence policy. It can query a product version or an
 * environment, compare two reports, and gate on a minimum verified percentage.
 *
 * The report is deterministic: behaviors sort by id, links sort by their stable keys, and no clock, network, or
 * environment is read. Private behaviors and evidence values never appear in the report or the comparison.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Diagnostic } from "../contracts/diagnostic.ts";
import type {
  BehaviorComparison,
  BehaviorEnvironment,
  BehaviorQuery,
  BehaviorReport,
  BehaviorSupportStatus,
} from "../contracts/behavior.ts";
import { formatBehaviorJson, formatBehaviorText } from "../behavior/format.ts";
import {
  behaviorReportOf,
  behaviorReportWith,
  compareBehaviorReports,
  queryBehaviors,
} from "../behavior/report.ts";
import { buildModel } from "../model/build.ts";
import { formatText } from "../pipeline/diagnostics.ts";

/** Where the command prints. */
export interface BehaviorIo {
  readonly log: (message: string) => void;
  readonly error: (message: string) => void;
}

export const behaviorUsage = `Usage: mizzen behavior [dir] [options]

  --json                Print the versioned report (schema/behavior-report.schema.json)
  --format <text|json>  Choose the output; \`--json\` is the same as \`--format json\`
  --version <version>   Return the contract at this product version and record it on the report
  --status <status>     Only supported, experimental, deprecated, or removed
  --os <name>           Only behaviors that cover this operating system
  --language <name>     Only behaviors that cover this language
  --runtime <name>      Only behaviors that cover this runtime
  --baseline <file>     Compare against an earlier report written by this command
  --out <file>          Write the report (or comparison) to this file instead of stdout
  --min-verified <pct>  Exit 1 when the verified percentage is below this, 0 to 100
`;

interface BehaviorArgs {
  readonly root: string;
  readonly format: "text" | "json";
  readonly baseline?: string;
  readonly out?: string;
  readonly minVerified?: number;
  readonly version?: string;
  readonly status?: BehaviorSupportStatus;
  readonly os?: string;
  readonly language?: string;
  readonly runtime?: string;
}

/** True for one of the four statuses. */
function isStatus(value: string): value is BehaviorSupportStatus {
  return value === "supported" || value === "experimental" || value === "deprecated" || value === "removed";
}

/** Parses the command's arguments. */
function parseBehavior(args: readonly string[]): BehaviorArgs | { readonly error: string } {
  let root = ".";
  let format: "text" | "json" | undefined;
  let baseline: string | undefined;
  let out: string | undefined;
  let minVerified: number | undefined;
  let version: string | undefined;
  let status: BehaviorSupportStatus | undefined;
  let os: string | undefined;
  let language: string | undefined;
  let runtime: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
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
      } else if (arg === "--baseline") baseline = next;
      else if (arg === "--out") out = next;
      else if (arg === "--version") version = next;
      else if (arg === "--os") os = next;
      else if (arg === "--language") language = next;
      else if (arg === "--runtime") runtime = next;
      else if (arg === "--status") {
        if (!isStatus(next)) return { error: "--status must be supported, experimental, deprecated, or removed" };
        status = next;
      } else if (arg === "--min-verified") {
        if (!/^\d+(?:\.\d+)?$/.test(next) || Number(next) > 100) {
          return { error: "--min-verified must be a percentage from 0 to 100" };
        }
        minVerified = Number(next);
      } else return { error: `unknown option: ${arg}` };
    } else if (root === ".") root = arg;
    else return { error: `unexpected argument: ${arg}` };
  }
  return {
    root,
    format: format ?? "text",
    ...(baseline === undefined ? {} : { baseline }),
    ...(out === undefined ? {} : { out }),
    ...(minVerified === undefined ? {} : { minVerified }),
    ...(version === undefined ? {} : { version }),
    ...(status === undefined ? {} : { status }),
    ...(os === undefined ? {} : { os }),
    ...(language === undefined ? {} : { language }),
    ...(runtime === undefined ? {} : { runtime }),
  };
}

/** Writes a file, creating its folder. */
async function writeReport(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
}

/** Reads a baseline report, or explains why it cannot. */
async function readBaseline(path: string): Promise<BehaviorReport | { readonly error: string }> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<BehaviorReport>;
    if (value.version !== 1 || !Array.isArray(value.behaviors) || value.coverage === undefined || value.policy === undefined) {
      return { error: `${path} is not a behavior report this command wrote.` };
    }
    return value as BehaviorReport;
  } catch (error) {
    return { error: `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** The query the options name; every field is optional. */
function queryOf(parsed: BehaviorArgs): BehaviorQuery {
  const environment: BehaviorEnvironment = {
    ...(parsed.os === undefined ? {} : { os: parsed.os }),
    ...(parsed.language === undefined ? {} : { language: parsed.language }),
    ...(parsed.runtime === undefined ? {} : { runtime: parsed.runtime }),
  };
  const hasEnvironment = parsed.os !== undefined || parsed.language !== undefined || parsed.runtime !== undefined;
  return {
    ...(parsed.version === undefined ? {} : { version: parsed.version }),
    ...(parsed.status === undefined ? {} : { status: parsed.status }),
    ...(hasEnvironment ? { environment } : {}),
  };
}

/** Runs `mizzen behavior` and returns the exit code. */
export async function runBehavior(args: readonly string[], io: BehaviorIo): Promise<number> {
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    io.log(`${behaviorUsage.replace(/\n$/, "")}\n`);
    return 0;
  }
  const parsed = parseBehavior(args);
  if ("error" in parsed) {
    if (parsed.error === "") {
      io.log(`${behaviorUsage.replace(/\n$/, "")}\n`);
      return 0;
    }
    io.error(`mizzen: ${parsed.error}\n\n${behaviorUsage}`);
    return 2;
  }
  const root = resolve(parsed.root);
  const model = await buildModel(root);
  const buildErrors: readonly Diagnostic[] = model.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  const { report, diagnostics } = await behaviorReportOf({
    site: model.site,
    root,
    ...(parsed.version === undefined ? {} : { version: parsed.version }),
  });
  const findings = [...buildErrors, ...diagnostics];
  if (parsed.format === "text" && findings.length > 0) io.error(formatText(findings).replace(/\n$/, ""));

  const query = queryOf(parsed);
  const queried =
    parsed.version !== undefined || parsed.status !== undefined || query.environment !== undefined
      ? behaviorReportWith(
          report,
          queryBehaviors(report, query).behaviors,
        )
      : report;

  let comparison: BehaviorComparison | undefined;
  if (parsed.baseline !== undefined) {
    const baseline = await readBaseline(parsed.baseline);
    if ("error" in baseline) {
      io.error(`mizzen: ${baseline.error}`);
      return 2;
    }
    comparison = compareBehaviorReports(baseline, report);
  }

  const text = parsed.format === "json" ? formatBehaviorJson(queried, comparison) : formatBehaviorText(queried, comparison);
  if (parsed.out === undefined) io.log(text.replace(/\n$/, ""));
  else await writeReport(resolve(parsed.out), text);

  if (buildErrors.length > 0) return 1;
  if (findings.some((finding) => finding.severity === "error")) return 1;
  const total = queried.coverage.total;
  if (
    parsed.minVerified !== undefined &&
    total > 0 &&
    (queried.coverage.verified / total) * 100 < parsed.minVerified
  ) {
    io.error(`mizzen: verified behavior coverage ${((queried.coverage.verified / total) * 100).toFixed(2)}% is below --min-verified ${parsed.minVerified}%`);
    return 1;
  }
  return 0;
}
