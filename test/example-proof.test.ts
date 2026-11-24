/**
 * Example status in a verification proof (#1336). A recorded example maps to one bounded check: a pass or fail is a
 * check with the matching status and an output hash, a skipped or stale result is `unrun` and never a pass.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FenceExampleResult } from "../src/contracts/code.ts";
import { exampleChecks } from "../src/examples/proof.ts";
import { createVerificationProof } from "../src/verification/proof.ts";
import { matchingOutputs, NO_REFERENCES, NO_REVIEW, verificationPlan, verificationTask } from "./verification-fixture.ts";

const LIMITS = { timeoutMs: 10_000, memoryMb: 0, network: "deny" as const, paths: "sandbox" as const };
const TASK = { task: "t1", snapshot: "s1", commit: "c".repeat(40), limits: LIMITS };

function result(overrides: Partial<FenceExampleResult> = {}): FenceExampleResult {
  return {
    status: "passed",
    file: "guide.md",
    line: 3,
    language: "js",
    date: "2026-11-23",
    commit: "a".repeat(40),
    sha256: "b".repeat(64),
    environment: "e".repeat(64),
    evidence: { exitCode: 0, outputs: [{ stream: "stdout", match: "exact", expected: "hi", actual: "hi", ok: true }] },
    ...overrides,
  } as FenceExampleResult;
}

test("a passing example becomes a passed check with an output hash and no span", () => {
  const [check] = exampleChecks({ ...TASK, results: { "example-1": result() } });
  assert.equal(check?.id, "example:example-1");
  assert.equal(check?.status, "passed");
  assert.equal(check?.outputHash.length, 64);
  assert.equal(check?.span, undefined);
  assert.match(check?.detail ?? "", /environment:/);
});

test("a failing example is a failed check with the fence's span", () => {
  const [check] = exampleChecks({ ...TASK, results: { "example-1": result({ status: "failed", evidence: { exitCode: 1, violation: "timeout", outputs: [] } }) } });
  assert.equal(check?.status, "failed");
  assert.equal(check?.span?.file, "guide.md");
  assert.equal(check?.span?.line, 3);
  assert.match(check?.detail ?? "", /violation: timeout/);
});

test("a skipped, sandbox-unavailable, or stale result is unrun, never a pass", () => {
  for (const status of ["skipped", "sandbox-unavailable"] as const) {
    const [check] = exampleChecks({ ...TASK, results: { "example-1": result({ status }) } });
    assert.equal(check?.status, "unrun", status);
  }
  const stale = {
    status: "stale",
    recordedStatus: "passed",
    file: "guide.md",
    line: 3,
    language: "js",
    date: "2026-11-23",
    commit: "a".repeat(40),
    sha256: "b".repeat(64),
  } as FenceExampleResult;
  const [check] = exampleChecks({ ...TASK, results: { "example-1": stale } });
  assert.equal(check?.status, "unrun");
});

test("checks are sorted by id and tied to the task, snapshot, and commit", () => {
  const checks = exampleChecks({ ...TASK, results: { "example-2": result(), "example-1": result() } });
  assert.deepEqual(checks.map((check) => check.id), ["example:example-1", "example:example-2"]);
  assert.ok(checks.every((check) => check.task === "t1" && check.snapshot === "s1" && check.commit === TASK.commit));
});

test("the same evidence produces the same output hash", () => {
  const first = exampleChecks({ ...TASK, results: { "example-1": result() } });
  const second = exampleChecks({ ...TASK, results: { "example-1": result() } });
  assert.equal(first[0]?.outputHash, second[0]?.outputHash);
});

test("a failing example check makes the real proof incomplete, never proved", () => {
  const task = verificationTask([{ id: "example", statement: "The example passes.", check: "test" }]);
  const plan = verificationPlan(task);
  const failing: FenceExampleResult = {
    status: "failed",
    file: "guide.md",
    line: 3,
    language: "js",
    date: "2026-11-23",
    commit: "abc1234",
    sha256: "b".repeat(64),
    evidence: { exitCode: 1, outputs: [{ stream: "stdout", match: "exact", expected: "hi", actual: "no", ok: false }] },
  };
  const checks = exampleChecks({
    task: task.id,
    snapshot: task.snapshot.id,
    commit: "abc1234",
    limits: { timeoutMs: 1000, memoryMb: 0, network: "deny", paths: "sandbox" },
    results: { example: failing },
  }).map((check) => ({ ...check, criterion: "example", id: "example" }));
  const proof = createVerificationProof({
    task,
    plan,
    commit: "abc1234",
    base: "def5678",
    files: [{ path: "docs/install.md", before: null, after: "e".repeat(64) }],
    allowed: ["docs/install.md"],
    expected: ["docs/install.md"],
    checks,
    outputs: matchingOutputs(),
    references: NO_REFERENCES,
    humanReview: NO_REVIEW,
  });
  assert.notEqual(proof.verdict, "proved", "a failed example cannot prove the criterion");
  assert.equal(proof.checks[0]?.status, "failed");
});
