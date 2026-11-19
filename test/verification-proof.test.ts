import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { verifyProof } from "../src/cli/edit-verify.ts";
import { writeProof } from "../src/edits/proof.ts";
import { sha256 } from "../src/data/lock.ts";
import { changeOf } from "../src/verification/scope.ts";
import {
  createVerificationProof,
  formatVerificationProof,
  parseVerificationProof,
  proofHashMatches,
  proofHashOf,
  proofVersionOf,
} from "../src/verification/proof.ts";
import { independentlyVerify } from "../src/verification/verify.ts";
import {
  matchingOutputs,
  NO_REFERENCES,
  NO_REVIEW,
  passedCheck,
  verificationPlan,
  verificationTask,
} from "./verification-fixture.ts";

const COMMIT = "abc1234";
const BASE = "def5678";

/** A proved proof for the single-check fixture task. */
function provedProof() {
  const task = verificationTask();
  const plan = verificationPlan(task);
  const check = passedCheck(task, "doctor");
  return createVerificationProof({
    task,
    plan,
    commit: COMMIT,
    base: BASE,
    files: [changeOf("docs/install.md", "before\n", "after\n")],
    allowed: ["docs/install.md"],
    expected: ["docs/install.md"],
    checks: [check],
    outputs: matchingOutputs(),
    references: NO_REFERENCES,
    humanReview: NO_REVIEW,
  });
}

test("a proof round-trips through the schema, its hash, and the independent verifier", async () => {
  const proof = provedProof();
  assert.equal(proof.verdict, "proved");
  assert.equal(proof.claims[0]?.status, "proved");
  assert.equal(proof.version, 2);

  const text = formatVerificationProof(proof);
  const parsed = parseVerificationProof(text);
  assert.deepEqual(parsed, proof);
  assert.equal(proofHashMatches(parsed), true);

  const report = await independentlyVerify(parsed, {
    input: {
      files: { "docs/install.md": sha256("after\n") },
      before: { "docs/install.md": sha256("before\n") },
      checks: { doctor: { status: "passed", outputHash: sha256("ok\n") } },
      outputHash: proof.outputs.actualHash,
    },
  });
  assert.deepEqual(report.failures, []);
  assert.equal(report.ok, true);
  assert.equal(report.agrees, true);
  assert.equal(report.proofHash, "matched");
  assert.equal(report.verdict, "proved");
});

test("identical runs produce the same bytes and the same proof hash", () => {
  const first = provedProof();
  const second = provedProof();
  assert.equal(formatVerificationProof(first), formatVerificationProof(second));
  assert.equal(first.proofHash, second.proofHash);
  const text = formatVerificationProof(first);
  assert.doesNotMatch(text, /\/Users\/|\/tmp\//u);
  assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T/u, "a proof carries no clock value");
});

test("the independent verifier rejects a proof edited after the fact", async () => {
  const proof = provedProof();
  const content = { ...proof, claims: proof.claims.map((claim) => ({ ...claim, status: "failed" as const })), proofHash: "" };
  const tampered = { ...content, proofHash: proofHashOf(content) };
  const report = await independentlyVerify(tampered, {
    input: {
      files: { "docs/install.md": sha256("after\n") },
      checks: { doctor: { status: "passed", outputHash: sha256("ok\n") } },
      outputHash: proof.outputs.actualHash,
    },
  });
  assert.equal(report.ok, false);
  assert.ok(report.failures.some((failure) => failure.code === "verification.claim"));
  assert.equal(report.proofHash, "matched");
});

test("a version 1 edit proof is still read by the edit proof verifier", async () => {
  const root = mkdtempSync(join(tmpdir(), "verification-v1-"));
  try {
    writeFileSync(join(root, "a.md"), "after\n");
    const proofPath = join(root, "edit.proof.json");
    await writeProof({
      siteRoot: root,
      files: ["a.md"],
      before: { "a.md": "before\n" },
      after: { "a.md": "after\n" },
      out: proofPath,
    });
    const text = readFileSync(proofPath, "utf8");
    assert.equal(proofVersionOf(text), 1);
    assert.throws(() => parseVerificationProof(text), /version 1 edit proof/u);
    const result = await verifyProof({ proof: proofPath, siteRoot: root });
    assert.equal(result.ok, true);
    assert.equal(result.verification, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
