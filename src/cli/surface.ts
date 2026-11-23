/**
 * `mizzen surface [dir]`: inventory the product's public surface, match it to documentation, and report coverage and
 * gaps. It can compare two reports and gate on a minimum documented percentage.
 *
 * The report is deterministic: adapters sort their items, matches sort by item, and no clock, network, or environment
 * is read. A private data field never appears in the report.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Diagnostic } from "../contracts/diagnostic.ts";
import type { SurfaceComparison, SurfaceReport } from "../contracts/surface.ts";
import { buildModel } from "../model/build.ts";
import { formatText } from "../pipeline/diagnostics.ts";
import { compareSurfaceReports } from "../surface/compare.ts";
import { formatSurfaceJson, formatSurfaceText } from "../surface/format.ts";
import { surfaceReportOf } from "../surface/report.ts";

/** Where the command prints. */
export interface SurfaceIo {
  readonly log: (message: string) => void;
  readonly error: (message: string) => void;
}

export const surfaceUsage = `Usage: mizzen surface [dir] [options]

  --json               Print the versioned report (schema/surface-report.schema.json)
  --format <text|json> Choose the output; \`--json\` is the same as \`--format json\`
  --baseline <file>    Compare against an earlier report written by this command
  --out <file>         Write the report (or comparison) to this file instead of stdout
  --min <percent>      Exit 1 when the documented percentage is below this, 0 to 100
  --version <version>  The product version to inventory, recorded on every item
`;

interface SurfaceArgs {
  readonly root: string;
  readonly format: "text" | "json";
  readonly baseline?: string;
  readonly out?: string;
  readonly min?: number;
  readonly productVersion?: string;
}

/** Parses the command's arguments. */
function parseSurface(args: readonly string[]): SurfaceArgs | { readonly error: string } {
  let root = ".";
  let format: "text" | "json" | undefined;
  let baseline: string | undefined;
  let out: string | undefined;
  let min: number | undefined;
  let productVersion: string | undefined;
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
      else if (arg === "--version") productVersion = next;
      else if (arg === "--min") {
        if (!/^\d+(?:\.\d+)?$/.test(next) || Number(next) > 100) return { error: "--min must be a percentage from 0 to 100" };
        min = Number(next);
      } else return { error: `unknown option: ${arg}` };
    } else if (root === ".") root = arg;
    else return { error: `unexpected argument: ${arg}` };
  }
  return {
    root,
    format: format ?? "text",
    ...(baseline === undefined ? {} : { baseline }),
    ...(out === undefined ? {} : { out }),
    ...(min === undefined ? {} : { min }),
    ...(productVersion === undefined ? {} : { productVersion }),
  };
}

/** Writes a file, creating its folder. */
async function writeReport(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
}

/** Reads a baseline report, or explains why it cannot. */
async function readBaseline(path: string): Promise<SurfaceReport | { readonly error: string }> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<SurfaceReport>;
    if (value.version !== 1 || !Array.isArray(value.items) || value.coverage === undefined) {
      return { error: `${path} is not a surface report this command wrote.` };
    }
    return value as SurfaceReport;
  } catch (error) {
    return { error: `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Runs `mizzen surface` and returns the exit code. */
export async function runSurface(args: readonly string[], io: SurfaceIo): Promise<number> {
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    io.log(`${surfaceUsage.replace(/\n$/, "")}\n`);
    return 0;
  }
  const parsed = parseSurface(args);
  if ("error" in parsed) {
    if (parsed.error === "") {
      io.log(`${surfaceUsage.replace(/\n$/, "")}\n`);
      return 0;
    }
    io.error(`mizzen: ${parsed.error}\n\n${surfaceUsage}`);
    return 2;
  }
  const root = resolve(parsed.root);
  const model = await buildModel(root);
  const buildErrors: readonly Diagnostic[] = model.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  const { report, diagnostics } = await surfaceReportOf({
    root,
    site: model.site,
    ...(parsed.productVersion === undefined ? {} : { version: parsed.productVersion }),
  });
  const findings = [...buildErrors, ...diagnostics];
  if (parsed.format === "text" && findings.length > 0) io.error(formatText(findings).replace(/\n$/, ""));

  let comparison: SurfaceComparison | undefined;
  if (parsed.baseline !== undefined) {
    const baseline = await readBaseline(parsed.baseline);
    if ("error" in baseline) {
      io.error(`mizzen: ${baseline.error}`);
      return 2;
    }
    comparison = compareSurfaceReports(baseline, report);
  }

  const text = parsed.format === "json" ? formatSurfaceJson(report, comparison) : formatSurfaceText(report, comparison);
  if (parsed.out === undefined) io.log(text.replace(/\n$/, ""));
  else await writeReport(resolve(parsed.out), text);

  // A build error is a failed run, because the surface was read from a model the site itself calls broken.
  if (buildErrors.length > 0) return 1;
  if (findings.some((finding) => finding.severity === "error")) return 1;
  if (parsed.min !== undefined && report.coverage.documentedPercent !== null && report.coverage.documentedPercent < parsed.min) {
    io.error(`mizzen: surface coverage ${report.coverage.documentedPercent.toFixed(2)}% is below --min ${parsed.min}%`);
    return 1;
  }
  return 0;
}
