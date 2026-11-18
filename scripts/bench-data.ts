// Measures a build of the generated data site (fixtures/data-large) for each record count: a cold build with no cache, a
// warm build that restores the whole-build cache, and a build after one record changed. Each case runs in its own node
// process, so peak memory is that build's own, and runs `--runs` times (default 3); the median is reported. The result is
// printed as JSON. The script never fails on a time or a size: bench/budget.json and `--check` are the gate.
//
// With `--check bench/budget.json` it prints each measurement next to its budget (and into the CI job summary) and exits 1
// when one is over: that is the gate. Without it, nothing is asserted.
//
// Usage: node scripts/bench-data.ts [--records 1000,10000] [--runs 3] [--theme ../lateen] [--check bench/budget.json]
//        [--report saved.json]   with --report, check that saved report instead of measuring again (the gate test does this)
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { write } from "../fixtures/data-large/generate.ts";
import type { BuildTimings } from "../src/pipeline/build.ts";

export const CASES = ["cold", "warm", "one-record", "search"] as const;
export type CaseName = (typeof CASES)[number];

export interface Measurement {
  readonly records: number;
  readonly case: CaseName;
  /** Median wall time of the runs, in milliseconds. */
  readonly ms: number;
  /** Median peak resident memory of the build process, in megabytes. */
  readonly peakMb: number;
  readonly renderedPages: number;
  readonly cachedPages: number;
  /** Size of the search index in kilobytes for the `search` case (the `search` output alone, no render); 0 for the others. */
  readonly indexKb: number;
  /**
   * Median of each stage's time, when the pipeline reported them. Absent for `search`, which runs one output, and for
   * `warm`, a whole-build cache hit where no stage ran.
   */
  readonly timings?: BuildTimings | undefined;
}

export interface BenchReport {
  readonly node: string;
  readonly platform: string;
  readonly arch: string;
  /** The CPU model the benchmark ran on, so a published table says which machine its numbers belong to. */
  readonly cpu?: string;
  readonly runs: number;
  readonly measurements: readonly Measurement[];
}

export const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
};

export interface BudgetFile {
  readonly budgets: Readonly<Record<string, Readonly<Record<string, { readonly ms: number; readonly peakMb: number; readonly indexKb?: number }>>>>;
}

export interface BudgetRow {
  readonly records: number;
  readonly case: string;
  readonly metric: "ms" | "peakMb" | "indexKb";
  readonly measured: number;
  readonly budget: number;
  readonly ok: boolean;
}

/** Each measurement next to its budget. A measurement with no budget is not a row: the budget file decides what is gated. */
export function checkBudget(report: BenchReport, file: BudgetFile): BudgetRow[] {
  const rows: BudgetRow[] = [];
  for (const m of report.measurements) {
    const budget = file.budgets[String(m.records)]?.[m.case];
    if (budget === undefined) continue;
    for (const metric of ["ms", "peakMb", "indexKb"] as const) {
      const limit = budget[metric];
      if (limit === undefined) continue;
      rows.push({ records: m.records, case: m.case, metric, measured: m[metric], budget: limit, ok: m[metric] <= limit });
    }
  }
  return rows;
}

/** The rows as a Markdown table, for the CI job summary. */
export function budgetTable(rows: readonly BudgetRow[]): string {
  const lines = ["| Records | Case | Metric | Measured | Budget | |", "| ---: | --- | --- | ---: | ---: | --- |"];
  for (const r of rows) lines.push(`| ${r.records} | ${r.case} | ${r.metric === "ms" ? "ms" : r.metric === "peakMb" ? "MB" : "KB"} | ${r.measured} | ${r.budget} | ${r.ok ? "ok" : "**over budget**"} |`);
  return `${lines.join("\n")}\n`;
}

const SELF = fileURLToPath(import.meta.url);

/** The `search` case: the site model and the search output alone, so indexing time and index size are not mixed with rendering. */
async function searchChild(args: Map<string, string>): Promise<void> {
  const { buildModel } = await import("../src/model/build.ts");
  const { search } = await import("../src/outputs/search.ts");
  const { site } = await buildModel(args.get("root") as string);
  const start = performance.now();
  const files = await search.run(site, {
    renderPage: async () => "",
    build: { root: args.get("root") as string, workers: 1 },
    report: () => undefined,
  });
  const ms = performance.now() - start;
  const indexKb = Math.round(files.reduce((total, file) => total + Buffer.byteLength(file.contents), 0) / 1024);
  const peakMb = process.resourceUsage().maxRSS / 1024;
  console.log(JSON.stringify({ ms, peakMb, renderedPages: 0, cachedPages: 0, indexKb }));
}

/** The child process: one build, reported as one JSON line. */
async function child(args: Map<string, string>): Promise<void> {
  if (args.has("search")) return searchChild(args);
  const { build } = await import("../src/pipeline/build.ts");
  const cache = args.get("cache") === "true";
  const start = performance.now();
  const result = await build({
    root: args.get("root") as string,
    out: args.get("out") as string,
    themeRoot: args.get("theme") as string,
    defaultLayout: "doc",
    cache,
    ...(cache ? { cacheDir: args.get("cache-dir") as string } : {}),
  });
  const ms = performance.now() - start;
  const peakMb = process.resourceUsage().maxRSS / 1024;
  console.log(
    JSON.stringify({
      ms,
      peakMb,
      renderedPages: result.renderedPages,
      cachedPages: result.cachedPages,
      indexKb: 0,
      ...(result.timings === undefined ? {} : { timings: result.timings }),
    }),
  );
}

interface Run {
  readonly ms: number;
  readonly peakMb: number;
  readonly renderedPages: number;
  readonly cachedPages: number;
  readonly indexKb: number;
  readonly timings?: BuildTimings | undefined;
}

function runChild(opts: { root: string; out: string; cacheDir: string; cache: boolean; theme: string; search?: boolean }): Run {
  const result = spawnSync(
    process.execPath,
    ["--no-warnings", SELF, "--child", "--root", opts.root, "--out", opts.out, "--cache-dir", opts.cacheDir, "--cache", String(opts.cache), "--theme", opts.theme, ...(opts.search === true ? ["--search"] : [])],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0) throw new Error(`bench child failed (${result.status}): ${result.stderr}`);
  return JSON.parse(result.stdout.trim().split("\n").at(-1) as string) as Run;
}

/** Changes the summary of one release in the middle of the file, differently on every run. */
export function editOneRecord(root: string, records: number, run: number): void {
  const file = join(root, "_data", "releases.json");
  const text = readFileSync(file, "utf8");
  const mid = Math.max(1, Math.floor(records / 4));
  const needle = `"summary": "Release ${mid} `;
  if (!text.includes(needle)) throw new Error(`bench: release ${mid} not found in ${file}`);
  writeFileSync(file, text.replace(needle, `${needle}(edit ${run}) `));
}

export function bench(options: { records: readonly number[]; runs: number; theme: string }): BenchReport {
  const measurements: Measurement[] = [];
  const parent = mkdtempSync(join(tmpdir(), "mizzen-bench-data-"));
  try {
    for (const records of options.records) {
      const root = join(parent, `site-${records}`);
      write(root, records);
      const out = join(parent, `out-${records}`);
      const cacheDir = join(parent, `cache-${records}`);
      const base = { root, out, cacheDir, theme: options.theme };
      const summarize = (name: CaseName, runs: readonly Run[]): void => {
        const timed = runs.flatMap((run) => (run.timings === undefined ? [] : [run.timings]));
        const stage = (key: keyof BuildTimings): number => Math.round(median(timed.map((timing) => timing[key])));
        measurements.push({
          records,
          case: name,
          ms: Math.round(median(runs.map((r) => r.ms))),
          peakMb: Math.round(median(runs.map((r) => r.peakMb))),
          renderedPages: median(runs.map((r) => r.renderedPages)),
          cachedPages: median(runs.map((r) => r.cachedPages)),
          indexKb: Math.round(median(runs.map((r) => r.indexKb))),
          ...(timed.length === 0
            ? {}
            : {
                timings: {
                  dataMs: stage("dataMs"),
                  renderMs: stage("renderMs"),
                  outputsMs: stage("outputsMs"),
                  writeMs: stage("writeMs"),
                },
              }),
        });
      };
      const cold = Array.from({ length: options.runs }, () => runChild({ ...base, cache: false }));
      summarize("cold", cold);
      runChild({ ...base, cache: true }); // fills the cache; not measured
      const warm = Array.from({ length: options.runs }, () => runChild({ ...base, cache: true }));
      summarize("warm", warm);
      const one = Array.from({ length: options.runs }, (_, i) => {
        editOneRecord(root, records, i + 1);
        return runChild({ ...base, cache: true });
      });
      summarize("one-record", one);
      summarize("search", Array.from({ length: options.runs }, () => runChild({ ...base, cache: false, search: true })));
      rmSync(join(parent, `site-${records}`), { recursive: true, force: true });
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
  return { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model ?? "unknown", runs: options.runs, measurements };
}

if (process.argv[1] && fileURLToPath(new URL(`file://${process.argv[1]}`)) === SELF) {
  const argv = process.argv.slice(2);
  const named = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith("--")) named.set(a.slice(2), argv[i + 1]?.startsWith("--") || argv[i + 1] === undefined ? "true" : (argv[++i] as string));
  }
  if (named.has("child")) {
    await child(named);
  } else {
    const records = (named.get("records") ?? "1000,10000").split(",").map(Number);
    const runs = Number(named.get("runs") ?? "3");
    const theme = fileURLToPath(new URL(named.get("theme") ?? "../../lateen", import.meta.url));
    mkdirSync(tmpdir(), { recursive: true });
    const saved = named.get("report");
    const report = saved === undefined ? bench({ records, runs, theme }) : (JSON.parse(readFileSync(saved, "utf8")) as BenchReport);
    console.log(JSON.stringify(report, null, 2));
    const budgetPath = named.get("check");
    if (budgetPath !== undefined) {
      const rows = checkBudget(report, JSON.parse(readFileSync(budgetPath, "utf8")) as BudgetFile);
      const table = budgetTable(rows);
      console.error(table);
      if (process.env.GITHUB_STEP_SUMMARY !== undefined) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Data benchmark\n\n${table}`);
      if (rows.some((r) => !r.ok)) process.exitCode = 1;
    }
  }
}
