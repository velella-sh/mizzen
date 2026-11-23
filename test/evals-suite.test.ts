import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { EVAL_RUBRIC_WEIGHTS } from "../src/contracts/evals.ts";
import { runEvalSuite } from "../src/evals/index.ts";
import { referenceRunner } from "../src/evals/reference.ts";

const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as new (options: object) => { compile(schema: object): (value: unknown) => boolean; errors?: unknown[] };
const SUITE = fileURLToPath(new URL("../fixtures/evals", import.meta.url));
const SCHEMA = fileURLToPath(new URL("../schema/eval-report.schema.json", import.meta.url));

test("the reference suite is deterministic and green with no recorded gap", async () => {
  const first = await runEvalSuite({ suite: SUITE });
  const second = await runEvalSuite({ suite: SUITE });

  assert.equal(first.report.totals.cases, 11);
  assert.equal(first.report.totals.passed, 11);
  assert.equal(first.report.totals.failed, 0);
  assert.equal(first.report.totals.invalid, 0);
  assert.equal(first.report.totals.unavailable, 0);
  assert.equal(first.report.gate.passed, true);
  assert.deepEqual(first.report.gate.unavailable, []);
  const conflict = first.report.cases.find((item) => item.id === "conflict.overlap");
  assert.equal(conflict?.status, "passed");
  assert.equal(conflict?.components.success, 1);
  assert.equal(conflict?.unavailable, undefined);

  assert.deepEqual(second.report, first.report, "two runs on the same pins give the same bytes");
  assert.equal(JSON.stringify(first.report), JSON.stringify(second.report));
});

test("a case reports every pin, the rubric, and separate components", async () => {
  const { report } = await runEvalSuite({ suite: SUITE });
  assert.equal(report.run.package, "source");
  assert.equal(report.pins.mizzen, "0.2.6");
  assert.deepEqual(report.rubric.weights, EVAL_RUBRIC_WEIGHTS);
  assert.ok(Math.abs(Object.values(EVAL_RUBRIC_WEIGHTS).reduce((total, weight) => total + weight, 0) - 1) < 1e-9);
  for (const item of report.cases) {
    assert.equal(item.version, 1);
    assert.match(item.pins.fixture, /^[0-9a-f]{64}$/);
    assert.match(item.pins.config, /^[0-9a-f]{64}$/);
    assert.match(item.pins.agent, /^([0-9a-f]{64}|none)$/);
    assert.equal(item.runner.id, "reference");
    for (const key of ["success", "evidence", "scope", "checks", "efficiency"] as const) {
      assert.ok(item.components[key] >= 0 && item.components[key] <= 1, `${item.id}: ${key}`);
    }
    assert.equal(item.security, "ok");
  }
});

test("the report conforms to its schema and holds no machine-local path", async () => {
  const { report } = await runEvalSuite({ suite: SUITE });
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(
    JSON.parse((await import("node:fs")).readFileSync(SCHEMA, "utf8")) as object,
  ) as ((value: unknown) => boolean) & { errors?: unknown[] };
  assert.equal(validate(report), true, JSON.stringify(validate.errors));
  assert.doesNotMatch(JSON.stringify(report), /\/Users\/|\/private\/|\/tmp\//u);
});

test("per-case metrics agree with the totals and with the trace", async () => {
  const { report } = await runEvalSuite({ suite: SUITE });
  assert.equal(report.totals.metrics.tokens, report.cases.reduce((total, item) => total + item.metrics.tokens, 0));
  assert.equal(report.totals.metrics.toolCalls, report.cases.reduce((total, item) => total + item.metrics.toolCalls, 0));
  assert.equal(report.totals.metrics.inputTokens + report.totals.metrics.outputTokens, report.totals.metrics.tokens);
});

test("an adapter without a pinned tool invalidates every case", async () => {
  const { report } = await runEvalSuite(
    { suite: SUITE },
    { ...referenceRunner, id: "missing-tools", tools: [] },
  );
  assert.equal(report.totals.invalid, 11);
  assert.equal(report.gate.passed, false);
  assert.ok(report.cases.every((item) => item.findings.some((finding) => finding.code === "eval.pin-tool")));
});

test("a package pin that differs from the suite invalidates the run", async () => {
  const { report } = await runEvalSuite({ suite: SUITE, package: "a-different-tarball" });
  assert.equal(report.totals.invalid, 11);
  assert.ok(report.cases.every((item) => item.findings.some((finding) => finding.code === "eval.pin-package")));
});
