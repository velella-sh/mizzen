/**
 * The public CLI entry point: report, badge, comparison, evaluation, gate, and `check --agents`. Issues #1265-#1267.
 */
import assert from "node:assert/strict";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli/index.ts";
import type { EvalReport } from "../src/contracts/evals.ts";
import type { ReadinessReport } from "../src/contracts/readiness.ts";
import { runEvalSuite } from "../src/evals/index.ts";
import { verifyReadinessReport } from "../src/readiness/report.ts";
import { buildFixture, copyBuild, FIXTURE_THEME, type BuiltFixture } from "./readiness-fixture.ts";

const EVALS_FIXTURE = fileURLToPath(new URL("../fixtures/evals", import.meta.url));

let built: BuiltFixture;

before(async () => {
  built = await buildFixture();
});

after(() => built.cleanup());

function capture(): { logs: string[]; errors: string[]; io: { log: (m: string) => void; error: (m: string) => void } } {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    io: {
      log: (m: string) => {
        logs.push(m);
      },
      error: (m: string) => {
        errors.push(m);
      },
    },
  };
}

test("readiness writes a verifiable report and a badge from the same build", async () => {
  const { logs, errors, io } = capture();
  const reportPath = join(built.parent, "readiness.json");
  const badgePath = join(built.parent, "readiness.svg");
  const code = await main(
    ["readiness", built.out, "--report", reportPath, "--badge", badgePath, "--evidence", "https://ci.example/actions/1"],
    io,
  );
  assert.equal(code, 0, errors.join("\n"));
  assert.match(logs.join("\n"), /Mizzen readiness 1\.0\.0/);
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as ReadinessReport;
  assert.equal(verifyReadinessReport(report), true);
  assert.equal(report.overall, 100);
  assert.equal(report.evidence, "https://ci.example/actions/1");
  const badge = readFileSync(badgePath, "utf8");
  assert.match(badge, /^<svg /);
  assert.match(badge, /readiness v1\.0\.0/);
  assert.match(badge, /https:\/\/ci\.example\/actions\/1/);
});

test("readiness --compare names the regression and exits 0 for a pass", async () => {
  const first = join(built.parent, "first.json");
  assert.equal(await main(["readiness", built.out, "--report", first], capture().io), 0);
  const { logs, io } = capture();
  const code = await main(["readiness", built.out, "--compare", first], io);
  assert.equal(code, 0);
  assert.match(logs.join("\n"), /Rules: 0 change\(s\)/);
});

test("readiness gates a threshold and a strict unknown policy", async () => {
  const pass = capture();
  assert.equal(await main(["readiness", built.out, "--min-overall", "90", "--min", "structure=100"], pass.io), 0);
  assert.deepEqual(pass.errors, []);

  const strict = capture();
  assert.equal(await main(["readiness", built.out, "--fail-on-unknown"], strict.io), 1);
  assert.match(strict.errors.join("\n"), /examples\.evaluation is unknown/);
  assert.match(strict.errors.join("\n"), /maintenance\.state is unknown/);

  const broken = copyBuild(built, "cli-broken");
  writeFileSync(join(broken, "sourcemap.json"), "{}");
  const failed = capture();
  assert.equal(await main(["readiness", broken, "--min-overall", "0"], failed.io), 1);
  assert.match(failed.errors.join("\n"), /critical verification\.digest failed/);
});

test("a matching evaluation report scores examples, and a mismatched suite exits 2", async () => {
  const reportPath = join(built.parent, "evaluated.json");
  assert.equal(await main(["readiness", built.out, "--report", reportPath], capture().io), 0);
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as ReadinessReport;
  const evaluationPath = join(built.parent, "evals.json");
  writeFileSync(
    evaluationPath,
    JSON.stringify({
      suite: "mizzen-readiness",
      version: "1.0.0",
      snapshot: report.build.hash,
      results: { "examples.evaluation": "pass" },
    }),
  );
  const evaluatedPath = join(built.parent, "evaluated-with.json");
  const code = await main(["readiness", built.out, "--evals", evaluationPath, "--report", evaluatedPath], capture().io);
  assert.equal(code, 0);
  const evaluated = JSON.parse(readFileSync(evaluatedPath, "utf8")) as ReadinessReport;
  assert.equal(evaluated.rules.find((rule) => rule.code === "examples.evaluation")?.status, "pass");
  assert.equal(evaluated.evaluations.status, "pass");
  assert.equal(evaluated.unknowns.some((rule) => rule.code === "examples.evaluation"), false);

  writeFileSync(
    evaluationPath,
    JSON.stringify({ suite: "another-suite", version: "1.0.0", snapshot: report.build.hash, results: {} }),
  );
  const mismatch = capture();
  assert.equal(await main(["readiness", built.out, "--evals", evaluationPath], mismatch.io), 2);
  assert.match(mismatch.errors.join("\n"), /another-suite/);
});

test("readiness exits 2 when the built folder has no manifest", async () => {
  const empty = join(built.parent, "not-a-build");
  const { errors, io } = capture();
  assert.equal(await main(["readiness", empty], io), 2);
  assert.match(errors.join("\n"), /build the site first/);
});

test("check --agents scores the staging build from the real CLI", async () => {
  const { logs, errors, io } = capture();
  const code = await main(["check", built.root, "--theme", FIXTURE_THEME, "--agents"], io);
  assert.equal(code, 0, errors.join("\n"));
  assert.deepEqual(errors, []);
  assert.match(logs.join("\n"), /Mizzen readiness 1\.0\.0/);
  assert.match(logs.join("\n"), /Status: pass/);
});

test("a real evaluation report with a build pin scores examples", async () => {
  const reportPath = join(built.parent, "eval-scored.json");
  assert.equal(await main(["readiness", built.out, "--report", reportPath], capture().io), 0);
  const scored = JSON.parse(readFileSync(reportPath, "utf8")) as ReadinessReport;

  const suite = join(built.parent, "readiness-evals");
  cpSync(EVALS_FIXTURE, suite, { recursive: true });
  writeFileSync(join(suite, "suite.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(suite, "suite.json"), "utf8")), id: "mizzen-readiness" }));
  const { report: evaluation } = await runEvalSuite({ suite, build: scored.build.hash });
  const evaluationPath = join(built.parent, "readiness-evaluation.json");
  writeFileSync(evaluationPath, `${JSON.stringify(evaluation, null, 2)}\n`);

  const outPath = join(built.parent, "eval-scored-with.json");
  const code = await main(["readiness", built.out, "--evals", evaluationPath, "--report", outPath], capture().io);
  assert.equal(code, 0);
  const evaluated = JSON.parse(readFileSync(outPath, "utf8")) as ReadinessReport;
  assert.equal(evaluated.rules.find((rule) => rule.code === "examples.evaluation")?.status, "pass");
  assert.equal(evaluated.evaluations.status, "pass");
  assert.equal(evaluated.evaluations.snapshot, scored.build.hash);
  assert.equal(evaluated.unknowns.some((rule) => rule.code === "examples.evaluation"), false);

  const unpinned = join(built.parent, "unpinned-evaluation.json");
  const { build: _build, ...pins } = evaluation.pins;
  writeFileSync(unpinned, JSON.stringify({ ...evaluation, pins }));
  const refused = capture();
  assert.equal(await main(["readiness", built.out, "--evals", unpinned], refused.io), 2);
  assert.match(refused.errors.join("\n"), /--build/);

  const failing = capture();
  writeFileSync(
    join(built.parent, "failing-evaluation.json"),
    JSON.stringify({
      ...evaluation,
      cases: evaluation.cases.map((entry, index) => (index === 0 ? { ...entry, status: "failed" as const } : entry)),
      gate: { ...evaluation.gate, passed: false, reasons: ["a case failed"] },
    }),
  );
  assert.equal(await main(["readiness", built.out, "--evals", join(built.parent, "failing-evaluation.json")], failing.io), 1);
  assert.match(failing.logs.join("\n"), /examples\.evaluation/);
});

test("readiness writes Markdown when the badge path ends in .md", async () => {
  const badgePath = join(built.parent, "badge.md");
  assert.equal(await main(["readiness", built.out, "--badge", badgePath], capture().io), 0);
  assert.match(readFileSync(badgePath, "utf8"), /!\[readiness v1\.0\.0/);
});
