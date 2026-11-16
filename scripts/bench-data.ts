// Measures a build of the generated data site (fixtures/data-large) for each record count: a cold build with no cache, a
// warm build that restores the whole-build cache, and a build after one record changed. Each case runs in its own node
// process, so peak memory is that build's own, and runs `--runs` times (default 3); the median is reported. The result is
// printed as JSON. The script never fails on a time or a size: bench/budget.json and `--check` are the gate.
//
// Usage: node scripts/bench-data.ts [--records 1000,10000] [--runs 3] [--theme ../lateen] [--check bench/budget.json]
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { write } from "../fixtures/data-large/generate.ts";

export const CASES = ["cold", "warm", "one-record"] as const;
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
}

export interface BenchReport {
  readonly node: string;
  readonly platform: string;
  readonly arch: string;
  readonly runs: number;
  readonly measurements: readonly Measurement[];
}

export const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
};

const SELF = fileURLToPath(import.meta.url);

/** The child process: one build, reported as one JSON line. */
async function child(args: Map<string, string>): Promise<void> {
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
  console.log(JSON.stringify({ ms, peakMb, renderedPages: result.renderedPages, cachedPages: result.cachedPages }));
}

interface Run {
  readonly ms: number;
  readonly peakMb: number;
  readonly renderedPages: number;
  readonly cachedPages: number;
}

function runChild(opts: { root: string; out: string; cacheDir: string; cache: boolean; theme: string }): Run {
  const result = spawnSync(
    process.execPath,
    ["--no-warnings", SELF, "--child", "--root", opts.root, "--out", opts.out, "--cache-dir", opts.cacheDir, "--cache", String(opts.cache), "--theme", opts.theme],
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
        measurements.push({
          records,
          case: name,
          ms: Math.round(median(runs.map((r) => r.ms))),
          peakMb: Math.round(median(runs.map((r) => r.peakMb))),
          renderedPages: median(runs.map((r) => r.renderedPages)),
          cachedPages: median(runs.map((r) => r.cachedPages)),
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
      rmSync(join(parent, `site-${records}`), { recursive: true, force: true });
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
  return { node: process.version, platform: process.platform, arch: process.arch, runs: options.runs, measurements };
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
    const report = bench({ records, runs, theme });
    console.log(JSON.stringify(report, null, 2));
  }
}
