import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { write } from "../fixtures/data-large/generate.ts";
import { editOneRecord } from "../scripts/bench-data.ts";

const script = fileURLToPath(new URL("../scripts/bench-data.ts", import.meta.url));

interface Measurement {
  readonly records: number;
  readonly case: string;
  readonly peakMb: number;
}

function measure(root: string, parent: string, cache: boolean): number {
  const run = spawnSync(process.execPath, [
    "--no-warnings", script, "--child", "--root", root, "--out", join(parent, "out"),
    "--cache-dir", join(parent, "cache"), "--cache", String(cache),
    "--theme", fileURLToPath(new URL("../../lateen", import.meta.url)),
  ], {
    encoding: "utf8",
    timeout: 480_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout).peakMb;
}

// A build must not keep every page's render, every output file and every cached render alive at once on top of the
// model, so memory grows with the record count by a small, bounded amount per record, not by the page's whole output.
test("peak memory grows by a bounded amount per record", () => {
  const [small, large] = [200, 1400];
  const found: Measurement[] = [];
  for (const records of [small, large]) {
    const parent = mkdtempSync(join(tmpdir(), "build-memory-"));
    const root = join(parent, "site");
    try {
      write(root, records);
      found.push({ records, case: "cold", peakMb: measure(root, parent, false) });
      measure(root, parent, true);
      editOneRecord(root, records, 1);
      found.push({ records, case: "one-record", peakMb: measure(root, parent, true) });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }
  for (const name of ["cold", "one-record"]) {
    const at = (records: number): number => (found.find((m) => m.records === records && m.case === name) as Measurement).peakMb;
    const perRecord = (at(large) - at(small)) / (large - small);
    // Measured about 0.2 MB per record; the bound leaves room for a slower or busier machine, and still fails when
    // whole sites are held more than once.
    assert.ok(perRecord < 0.6, `${name}: ${perRecord.toFixed(2)} MB per record (${at(small)} MB at ${small}, ${at(large)} MB at ${large})`);
  }
});
