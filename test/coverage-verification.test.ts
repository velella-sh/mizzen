/** Coverage for the independent verifier: public inputs, review evidence, claims, and package binding. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { VerificationProof, VerificationPublicInput } from "../src/contracts/verification.ts";
import { sha256 } from "../src/data/lock.ts";
import { createVerificationProof, proofHashOf } from "../src/verification/proof.ts";
import { independentlyVerify } from "../src/verification/verify.ts";
import {
  matchingOutputs,
  NO_REFERENCES,
  provedProof,
  verificationPlan,
  verificationTask,
} from "./verification-fixture.ts";

const COMMIT = "abc1234";
const BASE = "def5678";
const FILE = "docs/install.md";
const AFTER = sha256("after\n");
const BEFORE = sha256("before\n");
const OK = { status: "passed" as const, outputHash: sha256("ok\n") };
const OUTPUT = "e".repeat(64);

/** The public input a verifier gets for the one-check fixture proof. */
function publicInput(overrides: Partial<VerificationPublicInput> = {}): VerificationPublicInput {
  return {
    files: { [FILE]: AFTER },
    before: { [FILE]: BEFORE },
    checks: { doctor: OK },
    outputHash: OUTPUT,
    ...overrides,
  };
}

/** A proof with its hash recomputed for the edited content. */
function withHash(proof: VerificationProof): VerificationProof {
  return { ...proof, proofHash: proofHashOf(proof) };
}

test("a checkout is hashed when no public file set is supplied", async () => {
  const proof = provedProof();
  const root = mkdtempSync(join(tmpdir(), "coverage-verify-"));
  try {
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, FILE), "after\n");

    const trusted = await independentlyVerify(proof, {
      siteRoot: root,
      input: { checks: { doctor: OK }, outputHash: OUTPUT },
    });
    assert.deepEqual(trusted.failures, []);
    assert.equal(trusted.checked.files, 1);

    rmSync(join(root, FILE));
    const missing = await independentlyVerify(proof, {
      siteRoot: root,
      input: { checks: { doctor: OK }, outputHash: OUTPUT },
    });
    assert.ok(missing.failures.some((failure) => failure.code === "verification.file" && failure.path === FILE));

    const escaped = withHash({
      ...proof,
      transaction: { ...proof.transaction, files: [{ ...proof.transaction.files[0]!, path: "../escape.md" }] },
    });
    const unsafe = await independentlyVerify(escaped, {
      siteRoot: root,
      input: { checks: { doctor: OK }, outputHash: OUTPUT },
    });
    assert.ok(unsafe.failures.some((failure) => failure.code === "verification.path"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a changed proof record is reported as a mismatched hash", async () => {
  const proof = provedProof();
  const tampered = { ...proof, proofHash: "0".repeat(64) };
  const report = await independentlyVerify(tampered, { input: publicInput() });
  assert.equal(report.ok, false);
  assert.equal(report.proofHash, "mismatched");
  assert.ok(report.failures.some((failure) => failure.code === "verification.proof-hash"));
});

test("the public file set must name exactly the transaction's files, before and after", async () => {
  const proof = provedProof();

  const missing = await independentlyVerify(proof, { input: publicInput({ files: {} }) });
  assert.ok(missing.failures.some((failure) => failure.code === "verification.file" && failure.message.includes("missing")));

  const extra = await independentlyVerify(proof, {
    input: publicInput({ files: { [FILE]: AFTER, "extra.md": AFTER } }),
  });
  assert.ok(extra.failures.some((failure) => failure.code === "verification.file" && failure.message.includes("extra")));

  const after = await independentlyVerify(proof, { input: publicInput({ files: { [FILE]: sha256("other\n") } }) });
  assert.ok(after.failures.some((failure) => failure.code === "verification.file" && failure.message.includes("after")));

  const before = await independentlyVerify(proof, { input: publicInput({ before: { [FILE]: sha256("other\n") } }) });
  assert.ok(before.failures.some((failure) => failure.code === "verification.file" && failure.message.includes("before")));
});

test("every recorded check needs one public result and no extra results", async () => {
  const proof = provedProof();

  const missing = await independentlyVerify(proof, { input: publicInput({ checks: {} }) });
  assert.ok(missing.failures.some((failure) => failure.code === "verification.check" && failure.path === "doctor"));

  const extra = await independentlyVerify(proof, { input: publicInput({ checks: { doctor: OK, ghost: OK } }) });
  assert.ok(extra.failures.some((failure) => failure.code === "verification.check" && failure.path === "ghost"));

  const { checks: _checks, ...withoutChecks } = publicInput();
  const absent = await independentlyVerify(proof, { input: withoutChecks });
  assert.ok(absent.failures.some((failure) => failure.code === "verification.input-missing" && failure.message.includes("check results")));
});

test("the public output hash or files must reproduce the proof's output", async () => {
  const proof = provedProof();

  const wrongHash = await independentlyVerify(proof, { input: publicInput({ outputHash: "a".repeat(64) }) });
  assert.ok(wrongHash.failures.some((failure) => failure.code === "verification.output" && failure.message.includes("public output hash")));

  const { outputHash: _outputHash, ...withoutHash } = publicInput();
  const wrongFiles = await independentlyVerify(proof, { input: { ...withoutHash, outputs: { "a.html": "b".repeat(64) } } });
  assert.ok(wrongFiles.failures.some((failure) => failure.code === "verification.output" && failure.message.includes("public output files")));

  const absent = await independentlyVerify(proof, { input: withoutHash });
  assert.ok(absent.failures.some((failure) => failure.code === "verification.input-missing" && failure.message.includes("output hash")));

  const unexplained = withHash({
    ...proof,
    outputs: { ...proof.outputs, unexplained: [{ category: "outputs", path: "a.html" }] },
  });
  const odd = await independentlyVerify(unexplained, { input: publicInput() });
  assert.ok(odd.failures.some((failure) => failure.code === "verification.output" && failure.message.includes("unexplained")));
});

test("a human criterion needs a matching public decision", async () => {
  const task = verificationTask([{ id: "review", statement: "A person approved the change.", review: true }]);
  const plan = verificationPlan(task);
  const proof = createVerificationProof({
    task,
    plan,
    commit: COMMIT,
    base: BASE,
    files: [
      {
        path: FILE,
        before: BEFORE,
        after: AFTER,
      },
    ],
    allowed: [FILE],
    expected: [FILE],
    checks: [],
    outputs: matchingOutputs(),
    references: NO_REFERENCES,
    humanReview: { status: "approved", criteria: ["review"], reviewer: "Ada" },
  });
  assert.equal(proof.verdict, "proved");
  const base: VerificationPublicInput = {
    files: { [FILE]: AFTER },
    before: { [FILE]: BEFORE },
    checks: {},
    outputHash: OUTPUT,
    humanReview: { status: "approved", reviewer: "Ada" },
  };

  const approved = await independentlyVerify(proof, { input: base });
  assert.deepEqual(approved.failures, []);
  assert.equal(approved.checked.humanReview, true);

  const absent = await independentlyVerify(proof, { input: { files: base.files!, before: base.before!, checks: {}, outputHash: OUTPUT } });
  assert.ok(absent.failures.some((failure) => failure.code === "verification.input-missing" && failure.message.includes("human review")));
  assert.equal(absent.checked.humanReview, false);

  const status = await independentlyVerify(proof, { input: { ...base, humanReview: { status: "pending", reviewer: "Ada" } } });
  assert.ok(status.failures.some((failure) => failure.code === "verification.human-review" && failure.message.includes("status")));

  const reviewer = await independentlyVerify(proof, { input: { ...base, humanReview: { status: "approved", reviewer: "Grace" } } });
  assert.ok(reviewer.failures.some((failure) => failure.code === "verification.human-review" && failure.message.includes("reviewer")));
});

test("the proof must hold exactly one claim per planned criterion", async () => {
  const proof = provedProof();

  const empty = withHash({ ...proof, claims: [] });
  const none = await independentlyVerify(empty, { input: publicInput() });
  assert.ok(none.failures.some((failure) => failure.code === "verification.claim" && failure.message.includes("one claim per")));
  assert.ok(none.failures.some((failure) => failure.code === "verification.claim" && failure.path === "doctor"));

  const ghost = withHash({ ...proof, claims: [{ ...proof.claims[0]!, id: "ghost" }] });
  const extra = await independentlyVerify(ghost, { input: publicInput() });
  assert.ok(extra.failures.some((failure) => failure.code === "verification.claim" && failure.path === "doctor"));
  assert.ok(extra.failures.some((failure) => failure.code === "verification.claim" && failure.path === "ghost"));
});

test("the recomputed scope and reference summary must agree with the proof", async () => {
  const proof = provedProof();

  const scope = withHash({ ...proof, scope: { ...proof.scope, allowed: ["docs/other.md"] } });
  const wrongScope = await independentlyVerify(scope, { input: publicInput() });
  assert.ok(wrongScope.failures.some((failure) => failure.code === "verification.scope"));

  const references = withHash({ ...proof, references: { ...proof.references, ok: false } });
  const wrongReferences = await independentlyVerify(references, { input: publicInput() });
  assert.ok(wrongReferences.failures.some((failure) => failure.code === "verification.references"));
});

test("a release package must be bound to the public commit, tarball, and CI result", async () => {
  const proof = provedProof({
    package: { commit: COMMIT, tarballSha256: "c".repeat(64), ci: "passed" },
  });
  assert.equal(proof.verdict, "proved");

  const bound = await independentlyVerify(proof, {
    input: publicInput({ commit: COMMIT, tarballSha256: "c".repeat(64), ci: "passed" }),
  });
  assert.deepEqual(bound.failures, []);
  assert.equal(bound.checked.package, true);

  const absent = await independentlyVerify(proof, { input: publicInput() });
  assert.ok(absent.failures.some((failure) => failure.code === "verification.input-missing" && failure.message.includes("release package")));

  const wrong = await independentlyVerify(proof, {
    input: publicInput({ commit: "9999999", tarballSha256: "d".repeat(64), ci: "failed" }),
  });
  assert.ok(wrong.failures.some((failure) => failure.code === "verification.package" && failure.message.includes("commit")));
  assert.ok(wrong.failures.some((failure) => failure.code === "verification.package" && failure.message.includes("tarball")));
  assert.ok(wrong.failures.some((failure) => failure.code === "verification.package" && failure.message.includes("CI")));
});

test("a producer's verdict that the evidence does not support is refused", async () => {
  const proof = provedProof();
  const lied = withHash({ ...proof, verdict: "failed" });
  const report = await independentlyVerify(lied, { input: publicInput() });
  assert.equal(report.agrees, false);
  assert.equal(report.producerVerdict, "failed");
  assert.equal(report.verdict, "proved");
  assert.ok(report.failures.some((failure) => failure.code === "verification.verdict"));
});
