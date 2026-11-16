import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { BenchReport, BudgetFile } from "../scripts/bench-data.ts";
import { section, sitePage, withSection, START, END } from "../scripts/perf-doc.ts";

const script = fileURLToPath(new URL("../scripts/perf-doc.ts", import.meta.url));

const report: BenchReport = {
  node: "v24.0.0",
  platform: "darwin",
  arch: "arm64",
  cpu: "Test CPU",
  runs: 3,
  measurements: [
    { records: 1000, case: "cold", ms: 2200, peakMb: 250, renderedPages: 1011, cachedPages: 0, indexKb: 0 },
    { records: 1000, case: "search", ms: 140, peakMb: 160, renderedPages: 0, cachedPages: 0, indexKb: 930 },
  ],
};
const budgets: BudgetFile = { budgets: { "1000": { cold: { ms: 7000, peakMb: 650 }, search: { ms: 1000, peakMb: 400, indexKb: 2000 } } } };

test("the section prints each measured number next to its budget and names the machine", () => {
  const text = section(report, budgets);
  assert.match(text, /Test CPU \(darwin\/arm64\), Node 24\.0\.0, the median of 3 runs/);
  assert.match(text, /\| 1,000 \| cold build, no cache \| 2\.2 s \| 7\.0 s \| 250 MB \| 650 MB \| – \| 1,011 \| 0 \|/);
  assert.match(text, /\| 1,000 \| search index alone \| 0\.1 s \| 1\.0 s \| 160 MB \| 400 MB \| 930 KB \| – \| – \|/);
});

test("withSection replaces only what is between the markers", () => {
  const doc = `before\n${START}\nold\n${END}\nafter\n`;
  const out = withSection(doc, "NEW");
  assert.equal(out, "before\nNEW\nafter\n");
  assert.throws(() => withSection("no markers", "x"));
});

test("the site page carries the generated section and the rules for starting over", () => {
  const page = sitePage(report, budgets);
  assert.ok(page.includes(section(report, budgets)));
  assert.match(page, /^---\ntitle: Performance at scale\n/);
  assert.match(page, /## What makes a build start over/);
});

test("the committed pages are exactly what bench/last-run.json generates", () => {
  const run = spawnSync(process.execPath, ["--no-warnings", script, "--check"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
});
