import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { EvalReport } from "../src/contracts/evals.ts";
import { baselineOf, compareBaseline } from "../src/evals/baseline.ts";
import { runEvalSuite } from "../src/evals/index.ts";

const SUITE = fileURLToPath(new URL("../fixtures/evals", import.meta.url));

/** A report copy with one case changed, without touching the original. */
function mutate(report: EvalReport, id: string, change: (item: EvalReport["cases"][number]) => EvalReport["cases"][number]): EvalReport {
  return { ...report, cases: report.cases.map((item) => (item.id === id ? change(item) : item)) };
}

test("a report compared with itself has no changes", async () => {
  const { report } = await runEvalSuite({ suite: SUITE });
  const comparison = compareBaseline(report, baselineOf(report));
  assert.equal(comparison.comparable, true);
  assert.deepEqual(comparison.reasons, []);
  assert.deepEqual(comparison.regressed, []);
  assert.ok(comparison.cases.filter((item) => item.status === "unchanged").length >= 9);
  assert.ok(comparison.cases.some((item) => item.status === "incomparable" && item.id === "conflict.overlap"));
});

test("a lower score regresses and a higher score improves, per case", async () => {
  const { report } = await runEvalSuite({ suite: SUITE });
  const baseline = baselineOf(report);
  const lower = mutate(report, "answer.node-version", (item) => ({ ...item, weighted: 0.5 }));
  const regression = compareBaseline(lower, baseline);
  assert.equal(regression.comparable, true);
  assert.deepEqual(regression.regressed, ["answer.node-version"]);
  assert.equal(regression.cases.find((item) => item.id === "answer.node-version")?.status, "regressed");

  const lowered = { ...baseline, cases: baseline.cases.map((item) => item.id === "answer.node-version" ? { ...item, weighted: 0.5 } : item) };
  const improved = compareBaseline(report, lowered);
  assert.equal(improved.cases.find((item) => item.id === "answer.node-version")?.status, "improved");
});

test("a changed fixture or package pin makes the case incomparable with a reason", async () => {
  const { report } = await runEvalSuite({ suite: SUITE });
  const baseline = baselineOf(report);
  const changed = mutate(report, "answer.node-version", (item) => ({ ...item, pins: { ...item.pins, fixture: "0".repeat(64) } }));
  const comparison = compareBaseline(changed, baseline);
  const item = comparison.cases.find((entry) => entry.id === "answer.node-version");
  assert.equal(item?.status, "incomparable");
  assert.match(item?.reason ?? "", /fixture/u);

  const otherPackage = { ...report, pins: { ...report.pins, package: "another-tarball" } };
  const environment = compareBaseline(otherPackage, baseline);
  assert.equal(environment.comparable, false);
  assert.match(environment.reasons[0] ?? "", /package/u);
  assert.ok(environment.cases.every((entry) => entry.status === "incomparable" || entry.status === "new"));
});

test("new and removed cases are named instead of scored", async () => {
  const { report } = await runEvalSuite({ suite: SUITE });
  const baseline = baselineOf(report);
  const removed = { ...baseline, cases: baseline.cases.filter((item) => item.id !== "discovery.install") };
  const comparison = compareBaseline(report, removed);
  assert.equal(comparison.cases.find((item) => item.id === "discovery.install")?.status, "new");

  const extra = { ...baseline, cases: [...baseline.cases, { ...baseline.cases[0]!, id: "removed.case" }] };
  const gone = compareBaseline(report, extra);
  assert.equal(gone.cases.find((item) => item.id === "removed.case")?.status, "removed");
});
