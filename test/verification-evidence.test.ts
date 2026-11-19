import assert from "node:assert/strict";
import { test } from "node:test";
import type { VerificationCheck, VerificationHumanReview } from "../src/contracts/verification.ts";
import { sha256 } from "../src/data/lock.ts";
import {
  bindClaims,
  canComplete,
  completionOf,
  verificationVerdict,
} from "../src/verification/evidence.ts";
import { changeOf, scopeAllows, scopeMessage, scopeProof } from "../src/verification/scope.ts";
import { planVerification } from "../src/verification/plan.ts";
import {
  createVerificationProof,
  type VerificationProofInput,
} from "../src/verification/proof.ts";
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

/** A proof input for the single-check task. */
function inputOf(overrides: Partial<VerificationProofInput> = {}): VerificationProofInput {
  const task = verificationTask();
  return {
    task,
    plan: verificationPlan(task),
    commit: COMMIT,
    base: BASE,
    files: [changeOf("docs/install.md", "before\n", "after\n")],
    allowed: ["docs/install.md"],
    expected: ["docs/install.md"],
    checks: [passedCheck(task, "doctor")],
    outputs: matchingOutputs(),
    references: NO_REFERENCES,
    humanReview: NO_REVIEW,
    ...overrides,
  };
}

/** The file hashes of the default transaction. */
const FILES = { "docs/install.md": sha256("after\n") };

test("a check criterion is proved only by a matching passing check and its fixture", () => {
  const task = verificationTask();
  const plan = verificationPlan(task);
  const proved = bindClaims(plan, { checks: [passedCheck(task, "doctor")], humanReview: NO_REVIEW, files: FILES });
  assert.equal(proved[0]?.status, "proved");
  assert.deepEqual(proved[0]?.missing, []);
  assert.deepEqual(proved[0]?.evidence.map((item) => item.kind), ["check", "file"]);

  const missingCheck = bindClaims(plan, { checks: [], humanReview: NO_REVIEW, files: FILES });
  assert.equal(missingCheck[0]?.status, "unproven");
  assert.deepEqual(missingCheck[0]?.missing, ['check "doctor" did not run']);

  const missingFixture = bindClaims(plan, { checks: [passedCheck(task, "doctor")], humanReview: NO_REVIEW, files: {} });
  assert.equal(missingFixture[0]?.status, "unproven");
  assert.match(missingFixture[0]?.missing[0] ?? "", /fixture "docs\/install\.md"/u);

  const failed: VerificationCheck = { ...passedCheck(task, "doctor"), status: "failed", detail: "exit 1" };
  const failedClaim = bindClaims(plan, { checks: [failed], humanReview: NO_REVIEW, files: FILES });
  assert.equal(failedClaim[0]?.status, "failed");
  assert.deepEqual(failedClaim[0]?.missing, []);
});

test("a human criterion never passes without an approved decision", () => {
  const task = verificationTask([{ id: "review", statement: "A person approved the page.", review: true }]);
  const plan = verificationPlan(task);
  const pending: VerificationHumanReview = { status: "pending", criteria: ["review"] };
  const needs = bindClaims(plan, { checks: [], humanReview: pending, files: FILES });
  assert.equal(needs[0]?.status, "needs-review");
  assert.match(needs[0]?.missing[0] ?? "", /human review/u);

  const approved: VerificationHumanReview = { status: "approved", criteria: ["review"], reviewer: "sam" };
  const proved = bindClaims(plan, { checks: [], humanReview: approved, files: FILES });
  assert.equal(proved[0]?.status, "proved");
  assert.ok(proved[0]?.evidence.some((item) => item.kind === "human" && item.status === "approved"));

  const rejected: VerificationHumanReview = { status: "rejected", criteria: ["review"], reviewer: "sam" };
  assert.equal(bindClaims(plan, { checks: [], humanReview: rejected, files: FILES })[0]?.status, "failed");
});

test("a plan maps each criterion to a check, fixture, and expected evidence, and reports what it lacks", () => {
  const task = verificationTask([
    { id: "doctor", statement: "The doctor passes.", check: "doctor" },
    { id: "review", statement: "A person approved the page.", review: true },
  ]);
  const plan = verificationPlan(task);
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(plan.entries.map((entry) => entry.mode), ["check", "human"]);
  assert.equal(plan.entries[0]?.check, "doctor");
  assert.equal(plan.entries[0]?.fixture, "docs/install.md");
  assert.match(plan.entries[0]?.expected ?? "", /doctor/u);
  assert.equal(plan.entries[1]?.check, undefined);

  const broken = planVerification(task, [{ criterion: "review", check: "doctor", fixture: "", expected: "" }]);
  assert.ok(broken.problems.some((problem) => problem.code === "verification.plan-missing-fixture"));
  assert.ok(broken.problems.some((problem) => problem.code === "verification.plan-missing-spec"));
});

test("completion is refused for missing criteria, missing evidence, and failed claims", () => {
  const task = verificationTask();
  const proof = createVerificationProof(inputOf());
  assert.equal(canComplete(task, proof), true);
  assert.equal(completionOf(task, proof).status, "proved");

  const unproved = { ...proof, claims: [] };
  assert.equal(canComplete(task, unproved), false);
  assert.equal(completionOf(task, unproved).status, "unproven");
  assert.ok(completionOf(task, unproved).problems.some((problem) => problem.code === "verification.completion-unproven"));

  const failed = {
    ...proof,
    claims: proof.claims.map((claim) => ({ ...claim, status: "failed" as const, missing: [] })),
  };
  assert.equal(completionOf(task, failed).status, "failed");
});

test("a failed, unrun, or missing evidence result withholds a successful verdict", () => {
  const base = {
    criteriaCount: 1,
    checks: [passedCheck(verificationTask(), "doctor")],
    claims: [{ id: "doctor", criterion: "doctor", statement: "The doctor passes.", status: "proved" as const, evidence: [], missing: [] }],
    outputs: matchingOutputs(),
    scope: scopeProof({ allowed: ["docs/install.md"], expected: [], changes: [] }),
    references: NO_REFERENCES,
    humanReview: NO_REVIEW,
  };
  assert.equal(verificationVerdict(base), "proved");
  assert.equal(verificationVerdict({ ...base, checks: [{ ...base.checks[0]!, status: "failed" }] }), "failed");
  assert.equal(verificationVerdict({ ...base, checks: [{ ...base.checks[0]!, status: "timed-out" }] }), "failed");
  assert.equal(verificationVerdict({ ...base, checks: [{ ...base.checks[0]!, status: "unrun" }] }), "incomplete");
  assert.equal(verificationVerdict({ ...base, claims: [] }), "incomplete");
  assert.equal(
    verificationVerdict({ ...base, claims: [{ ...base.claims[0]!, status: "needs-review" }] }),
    "incomplete",
  );
  assert.equal(
    verificationVerdict({ ...base, outputs: { ...matchingOutputs(), unexplained: [{ category: "outputs", path: "hash" }] } }),
    "failed",
  );
});

test("scope proof lists every change and separates out-of-scope from unexpected files", () => {
  const changes = [
    changeOf("docs/install.md", "before\n", "after\n"),
    changeOf("docs/extra.md", null, "new\n"),
    changeOf("theme/layout.ts", "a\n", "b\n"),
  ];
  const scope = scopeProof({
    allowed: ["docs/install.md", "docs/"],
    expected: ["docs/install.md"],
    changes,
  });
  assert.deepEqual(scope.changes.map((change) => change.path), ["docs/extra.md", "docs/install.md", "theme/layout.ts"]);
  assert.deepEqual(scope.outOfScope, ["theme/layout.ts"]);
  assert.deepEqual(scope.unexpected, ["docs/extra.md"]);
  assert.equal(scope.ok, false);
  assert.match(scopeMessage(scope), /out of scope: theme\/layout\.ts/u);
  assert.equal(scopeAllows(["docs/"], "docs/deep/page.md"), true);
  assert.equal(scopeAllows(["docs/"], "docsish/page.md"), false);
});
