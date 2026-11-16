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
