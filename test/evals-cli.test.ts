import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { baselineOf } from "../src/evals/baseline.ts";
import type { EvalReport } from "../src/contracts/evals.ts";
import { main } from "../src/cli/index.ts";

const SUITE = fileURLToPath(new URL("../fixtures/evals", import.meta.url));

/** Captures the CLI's output. */
function capture(): { logs: string[]; errors: string[]; io: { write: (m: string) => void; error: (m: string) => void } } {
  const logs: string[] = [];
  const errors: string[] = [];
  return { logs, errors, io: { write: (m) => logs.push(m), error: (m) => errors.push(m) } };
}

test("mizzen eval prints a JSON report and exits 0 for the reference suite", async () => {
  const { logs, errors, io } = capture();
  const status = await main(["eval", SUITE, "--format", "json"], io);
  assert.equal(status, 0, errors.join("\n"));
  const report = JSON.parse(logs.join("")) as EvalReport;
  assert.equal(report.totals.passed, 10);
  assert.equal(report.gate.passed, true);
  assert.equal(report.rubric.critical, "security");
});

test("mizzen eval prints a text summary and writes --out", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mizzen-eval-cli-"));
  try {
    const out = join(dir, "report.json");
    const { logs, errors, io } = capture();
    const status = await main(["eval", SUITE, "--format", "json", "--out", out], io);
    assert.equal(status, 0, errors.join("\n"));
    assert.deepEqual(logs, []);
    const report = JSON.parse(readFileSync(out, "utf8")) as EvalReport;
    assert.equal(report.cases.length, 10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const text = capture();
  assert.equal(await main(["eval", SUITE], text.io), 0, text.errors.join("\n"));
  assert.match(text.logs.join(""), /10 passed, 0 failed, 0 invalid, 0 unavailable/);
  assert.match(text.logs.join(""), /gate: passed/);
});

test("mizzen eval compares with a baseline and reports a changed pin", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mizzen-eval-baseline-"));
  try {
    const run = capture();
    assert.equal(await main(["eval", SUITE, "--format", "json"], run.io), 0);
    const report = JSON.parse(run.logs.join("")) as EvalReport;
    const recorded = baselineOf(report);
    const baseline = {
      ...recorded,
      cases: recorded.cases.map((item) => item.id === "answer.node-version" ? { ...item, pins: { ...item.pins, fixture: "0".repeat(64) } } : item),
    };
    const file = join(dir, "baseline.json");
    writeFileSync(file, `${JSON.stringify(baseline, null, 2)}\n`);

    const compared = capture();
    assert.equal(await main(["eval", SUITE, "--format", "json", "--baseline", file], compared.io), 0, compared.errors.join("\n"));
    const withBaseline = JSON.parse(compared.logs.join("")) as EvalReport;
    assert.equal(withBaseline.baseline?.comparable, true);
    assert.equal(withBaseline.baseline?.cases.find((item) => item.id === "answer.node-version")?.status, "incomparable");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a malformed suite is a usage error and a failing gate exits 1", async () => {
  const missing = capture();
  assert.equal(await main(["eval", join(tmpdir(), "no-such-eval-suite")], missing.io), 2);
  assert.match(missing.errors.join(""), /cannot read the suite/);

  const bad = capture();
  assert.equal(await main(["eval", SUITE, "--format", "yaml"], bad.io), 2);
  assert.match(bad.errors.join(""), /text or json/);
});
