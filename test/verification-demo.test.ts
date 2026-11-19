import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { VerificationCheck, VerificationProof } from "../src/contracts/verification.ts";
import { sha256 } from "../src/data/lock.ts";
import { completionOf } from "../src/verification/evidence.ts";
import { verifyExample } from "../src/verification/examples.ts";
import {
  createVerificationProof,
  formatVerificationProof,
} from "../src/verification/proof.ts";
import { independentlyVerify } from "../src/verification/verify.ts";
import { changeOf } from "../src/verification/scope.ts";
import {
  matchingOutputs,
  NO_REFERENCES,
  NO_REVIEW,
  verificationPlan,
  verificationTask,
} from "./verification-fixture.ts";

const COMMIT = "abc1234";
const BASE = "def5678";
const FILE = "docs/install.md";
const SPAN = { line: 3, column: 1, endLine: 3, endColumn: 20 };
const VERIFIER = fileURLToPath(new URL("./fixtures/verification/verify.mjs", import.meta.url));

/** A demo proof built from one example check. */
function proofWith(task: Awaited<ReturnType<typeof verificationTask>>, check: VerificationCheck): VerificationProof {
  return createVerificationProof({
    task,
    plan: verificationPlan(task),
    commit: COMMIT,
    base: BASE,
    files: [changeOf(FILE, "before\n", "after\n")],
    allowed: [FILE],
    expected: [FILE],
    checks: [check],
    outputs: matchingOutputs(),
    references: NO_REFERENCES,
    humanReview: NO_REVIEW,
  });
}

/** The public evidence an independent verifier gets, never the producer's claim. */
function publicInput(check: VerificationCheck) {
  return {
    files: { [FILE]: sha256("after\n") },
    before: { [FILE]: sha256("before\n") },
    checks: { [check.id]: { status: check.status, outputHash: check.outputHash } },
    outputHash: "e".repeat(64),
  };
}

test("the demo stops without a successful proof, then a fresh process verifies the fixed proof (#1192)", async () => {
  const task = verificationTask([{ id: "example", statement: "The install example prints 2.", check: "test" }]);
  const broken = await verifyExample({
    id: "test",
    task: task.id,
    snapshot: task.snapshot.id,
    commit: COMMIT,
    file: FILE,
    span: SPAN,
    lang: "js",
    code: "console.log(1 + 1);\n",
    expected: "3\n",
  });
  const brokenProof = proofWith(task, broken.check);
  assert.equal(brokenProof.verdict, "failed");
  assert.equal(completionOf(task, brokenProof).status, "failed");
  assert.equal(brokenProof.claims[0]?.status, "failed");

  const brokenReport = await independentlyVerify(brokenProof, { input: publicInput(broken.check) });
  assert.equal(brokenReport.ok, false);
  assert.equal(brokenReport.verdict, "failed");
  assert.ok(brokenReport.failures.length > 0);

  const fixed = await verifyExample({
    id: "test",
    task: task.id,
    snapshot: task.snapshot.id,
    commit: COMMIT,
    file: FILE,
    span: SPAN,
    lang: "js",
    code: "console.log(1 + 1);\n",
    expected: "2\n",
  });
  const fixedProof = proofWith(task, fixed.check);
  assert.equal(fixedProof.verdict, "proved");
  assert.equal(completionOf(task, fixedProof).status, "proved");

  const directory = mkdtempSync(join(tmpdir(), "verification-demo-"));
  try {
    const proofPath = join(directory, "proof.json");
    const inputPath = join(directory, "input.json");
    writeFileSync(proofPath, formatVerificationProof(fixedProof));
    writeFileSync(inputPath, `${JSON.stringify(publicInput(fixed.check), null, 2)}\n`);
    const fresh = spawnSync(process.execPath, [VERIFIER, proofPath, inputPath], { encoding: "utf8" });
    assert.equal(fresh.status, 0, fresh.stderr);
    const report = JSON.parse(fresh.stdout) as Awaited<ReturnType<typeof independentlyVerify>>;
    assert.equal(report.ok, true);
    assert.equal(report.verdict, "proved");
    assert.equal(report.agrees, true);
    assert.equal(report.proofHash, "matched");
    assert.equal(report.checked.checks, 1);
    assert.equal(report.checked.files, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
