/** `mizzen reproduce` and `mizzen compare`: preflight a recorded build, rebuild it, and attribute the differences. */
import { join } from "node:path";
import { build } from "../pipeline/build.ts";
import {
  BUILD_REPORT_PATH,
  buildReportOf,
  compareBuildReports,
  comparisonJson,
  comparisonText,
  preflightReport,
  preflightText,
  readBuildReport,
  writeBuildReport,
  type BuildComparison,
  type Preflight,
} from "../reproduce/manifest.ts";

export interface ReproduceOptions {
  /** The report to reproduce. */
  readonly manifest: string;
  /** Site root. */
  readonly root: string;
  /** Output folder. */
  readonly out: string;
  /** Theme root, already resolved. */
  readonly themeRoot: string;
  readonly check: boolean;
  readonly format: "text" | "json";
  readonly asOf?: string;
  readonly base?: string;
}

export interface ReproduceResult {
  readonly code: number;
  readonly output: string;
  readonly problems: readonly string[];
}

/** The JSON form of a preflight, shared by `--check` and a full reproduction. */
function preflightJson(preflight: Preflight): unknown {
  return { ok: preflight.ok, problems: preflight.problems };
}

/**
 * Reads `options.manifest`, names every missing input or incompatible version, then builds without the cache and
 * compares the fresh report with the recorded one. A fatal preflight problem stops before the build.
 */
export async function reproduce(options: ReproduceOptions): Promise<ReproduceResult> {
  const read = await readBuildReport(options.manifest);
  if ("error" in read) return { code: 2, output: "", problems: [read.error] };

  const asOf = options.asOf ?? read.report.config.referenceDate;
  const preflight = await preflightReport(read.report, {
    root: options.root,
    ...(options.themeRoot === undefined ? {} : { themeRoot: options.themeRoot }),
    ...(asOf === undefined ? {} : { asOf }),
    ...(options.base === undefined ? {} : { base: options.base }),
  });

  if (options.check) {
    return {
      code: preflight.ok ? 0 : 1,
      output: options.format === "json" ? `${JSON.stringify(preflightJson(preflight), null, 2)}\n` : preflightText(preflight),
      problems: [],
    };
  }
  if (!preflight.ok) {
    return {
      code: 1,
      output: "",
      problems: preflight.problems.filter((problem) => problem.fatal).map((problem) => `${problem.category}: ${problem.message}`),
    };
  }

  const result = await build({
    root: options.root,
    out: options.out,
    themeRoot: options.themeRoot,
    defaultLayout: "doc",
    cache: false,
    ...(asOf === undefined ? {} : { asOf: asOf }),
    ...(options.base === undefined ? {} : { base: options.base }),
  });
  const report = await buildReportOf({
    root: options.root,
    out: options.out,
    themeRoot: options.themeRoot,
    ...(asOf === undefined ? {} : { asOf: asOf }),
    ...(options.base === undefined ? {} : { base: options.base }),
  });
  await writeBuildReport(join(options.root, BUILD_REPORT_PATH), report);
  const comparison = compareBuildReports(read.report, report);

  const output =
    options.format === "json"
      ? `${JSON.stringify({ preflight: preflightJson(preflight), comparison }, null, 2)}\n`
      : `${preflightText(preflight)}${comparisonText(comparison)}`;
  const errors = result.diagnostics.filter((finding) => finding.severity === "error");
  return {
    code: errors.length === 0 && read.report.outputs.hash === report.outputs.hash ? 0 : 1,
    output,
    problems: [],
  };
}

export interface CompareOptions {
  readonly before: string;
  readonly after: string;
  readonly format: "text" | "json";
}

/** Reads two reports and prints the differences grouped by category. */
export async function compareReports(options: CompareOptions): Promise<ReproduceResult> {
  const before = await readBuildReport(options.before);
  if ("error" in before) return { code: 2, output: "", problems: [before.error] };
  const after = await readBuildReport(options.after);
  if ("error" in after) return { code: 2, output: "", problems: [after.error] };
  const comparison: BuildComparison = compareBuildReports(before.report, after.report);
  return {
    code: 0,
    output: options.format === "json" ? comparisonJson(comparison) : comparisonText(comparison),
    problems: [],
  };
}
