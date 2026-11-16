import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CASES, median } from "../scripts/bench-data.ts";

const script = fileURLToPath(new URL("../scripts/bench-data.ts", import.meta.url));

test("median picks the middle value and averages two", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

test("the benchmark prints one measurement per record count and case, as JSON", () => {
  const run = spawnSync(process.execPath, ["--no-warnings", script, "--records", "30,60", "--runs", "1"], { encoding: "utf8", timeout: 240_000 });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.runs, 1);
  assert.equal(typeof report.node, "string");
  assert.equal(report.measurements.length, 6);
  assert.deepEqual(
    report.measurements.map((m: { records: number; case: string }) => [m.records, m.case]),
    [30, 60].flatMap((records) => CASES.map((name) => [records, name])),
  );
  for (const m of report.measurements) {
    assert.deepEqual(Object.keys(m).sort(), ["cachedPages", "case", "ms", "peakMb", "records", "renderedPages"]);
    assert.ok(m.ms > 0 && m.peakMb > 0);
  }
  const one = report.measurements.find((m: { case: string; records: number }) => m.case === "one-record" && m.records === 60);
  assert.ok(one.renderedPages >= 1);
});

test("checkBudget pairs each measurement with its budget and flags the ones over", async () => {
  const { checkBudget, budgetTable } = await import("../scripts/bench-data.ts");
  const report = {
    node: "v0",
    platform: "x",
    arch: "y",
    runs: 1,
    measurements: [
      { records: 10, case: "cold", ms: 100, peakMb: 50, renderedPages: 1, cachedPages: 0 },
      { records: 10, case: "warm", ms: 5, peakMb: 50, renderedPages: 0, cachedPages: 0 },
      { records: 99, case: "cold", ms: 1, peakMb: 1, renderedPages: 0, cachedPages: 0 },
    ],
  } as const;
  const rows = checkBudget(report, { budgets: { "10": { cold: { ms: 90, peakMb: 60 }, warm: { ms: 10, peakMb: 60 } } } });
  assert.deepEqual(
    rows.map((r) => [r.case, r.metric, r.ok]),
    [["cold", "ms", false], ["cold", "peakMb", true], ["warm", "ms", true], ["warm", "peakMb", true]],
  );
  assert.match(budgetTable(rows), /\*\*over budget\*\*/);
});

test("the committed budget file covers every case of 1,000 and 10,000 records", async () => {
  const { readFileSync } = await import("node:fs");
  const file = JSON.parse(readFileSync(fileURLToPath(new URL("../bench/budget.json", import.meta.url)), "utf8"));
  for (const records of ["1000", "10000"]) {
    for (const name of CASES) {
      assert.ok(file.budgets[records][name].ms > 0 && file.budgets[records][name].peakMb > 0, `${records}/${name}`);
    }
  }
});
