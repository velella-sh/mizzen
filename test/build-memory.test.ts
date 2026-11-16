import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/bench-data.ts", import.meta.url));

interface Measurement {
  readonly records: number;
  readonly case: string;
  readonly peakMb: number;
}

function measure(records: string): Measurement[] {
  const run = spawnSync(process.execPath, ["--no-warnings", script, "--records", records, "--runs", "1"], {
    encoding: "utf8",
    timeout: 480_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout).measurements;
}

// A build must not keep every page's render, every output file and every cached render alive at once on top of the
// model, so memory grows with the record count by a small, bounded amount per record, not by the page's whole output.
test("peak memory grows by a bounded amount per record", () => {
  const [small, large] = [200, 1400];
  const found = measure(`${small},${large}`);
  for (const name of ["cold", "one-record"]) {
    const at = (records: number): number => (found.find((m) => m.records === records && m.case === name) as Measurement).peakMb;
    const perRecord = (at(large) - at(small)) / (large - small);
    // Measured about 0.2 MB per record; the bound leaves room for a slower or busier machine, and still fails when
    // whole sites are held more than once.
    assert.ok(perRecord < 0.6, `${name}: ${perRecord.toFixed(2)} MB per record (${at(small)} MB at ${small}, ${at(large)} MB at ${large})`);
  }
});
