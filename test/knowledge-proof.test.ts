/**
 * #1371: a proof cannot mark an unknown or unverified claim as verified, and the task stays actionable by naming the
 * evidence or human review it needs.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TaskContract } from "../src/contracts/task.ts";
import { registerTask } from "../src/tasks/register.ts";
import { planVerification } from "../src/verification/plan.ts";
import { completionOf } from "../src/verification/evidence.ts";
import { createVerificationProof, type VerificationProofInput } from "../src/verification/proof.ts";
import { changeOf } from "../src/verification/scope.ts";
import { sha256 } from "../src/data/lock.ts";
import { snapshotIdOf } from "../src/tasks/snapshot.ts";
import { matchingOutputs, NO_REFERENCES, NO_REVIEW, passedCheck } from "./verification-fixture.ts";

/** A contract whose one criterion rests on a knowledge status. */
function contract(knowledge: "unknown" | "unverified", needs: { evidence?: string; review?: boolean }): TaskContract {
  const snapshot = { content: "a".repeat(64), data: "b".repeat(64), config: "c".repeat(64), tooling: "d".repeat(64) };
  return {
    version: 1,
    idempotencyKey: `knowledge-${knowledge}-${needs.evidence ?? ""}-${needs.review ?? ""}`,
    goal: "Check the claim",
    scope: { pages: [], blocks: [], collections: [], symbols: [], files: ["docs/install.md"] },
    snapshot: { ...snapshot, id: snapshotIdOf(snapshot) },
    budget: { contextTokens: 1000, toolCalls: 3, timeMs: 1000 },
    permissions: { read: ["*"], write: [], check: ["*"] },
    acceptance: [{ id: "claim", statement: "The claim holds.", check: "doctor", knowledge, needs }],
  };
}

/** A proof input for a knowledge criterion, with a passing check and the fixture present. */
function proofInput(knowledge: "unknown" | "unverified", needs: { evidence?: string; review?: boolean }): VerificationProofInput {
  const registered = registerTask(contract(knowledge, needs), { checks: ["doctor"] });
  assert.deepEqual(registered.problems, []);
  assert.ok(registered.task);
  const task = registered.task;
  const plan = planVerification(task, [
    { criterion: "claim", check: "doctor", fixture: "docs/install.md", expected: "the claim is confirmed" },
  ]);
  assert.deepEqual(plan.problems, []);
  return {
    task,
    plan,
    commit: "abc1234",
    base: "def5678",
    files: [changeOf("docs/install.md", "before\n", "after\n")],
    allowed: ["docs/install.md"],
    expected: ["docs/install.md"],
    checks: [passedCheck(task, "claim", "doctor")],
    outputs: matchingOutputs(),
    references: NO_REFERENCES,
    humanReview: NO_REVIEW,
  };
}

test("#1371 the contract keeps the knowledge status and the need, and refuses one without the other", () => {
  const withNeed = registerTask(contract("unknown", { evidence: "the vendor's changelog" }), { checks: ["doctor"] });
  assert.deepEqual(withNeed.problems, []);
  assert.equal(withNeed.task?.acceptance[0]?.knowledge, "unknown");
  assert.equal(withNeed.task?.acceptance[0]?.needs?.evidence, "the vendor's changelog");

  const withoutNeed = registerTask(contract("unverified", {}), { checks: ["doctor"] });
  assert.ok(withoutNeed.problems.some((problem) => problem.code === "task.acceptance-needs-missing"));
});

test("#1371 a passing check never proves an unknown or unverified claim", () => {
  for (const knowledge of ["unknown", "unverified"] as const) {
    const proof = createVerificationProof(proofInput(knowledge, { evidence: "a dated source" }));
    const claim = proof.claims.find((entry) => entry.criterion === "claim");
    assert.notEqual(claim?.status, "proved", `${knowledge}: a passing check must not prove it`);
    assert.match(claim?.missing.join(" ") ?? "", /dated source/, "the claim names the evidence it needs");
    assert.equal(proof.verdict, "incomplete", `${knowledge}: the verdict is withheld`);
  }
});

test("#1371 an approval never proves an unknown claim, and the claim names the human review it needs", () => {
  const proof = createVerificationProof({
    ...proofInput("unknown", { review: true }),
    humanReview: { status: "approved", criteria: ["claim"], reviewer: "reviewer" },
  });
  const claim = proof.claims.find((entry) => entry.criterion === "claim");
  assert.equal(claim?.status, "needs-review");
  assert.match(claim?.missing.join(" ") ?? "", /human review/);
  assert.equal(proof.verdict, "incomplete");
});

test("#1371 a knowledge claim cannot complete the task and names what it still needs", () => {
  const input = proofInput("unverified", { evidence: "a runnable sample" });
  const proof = createVerificationProof(input);
  const completion = completionOf(input.task, proof);
  assert.equal(completion.status, "unproven");
  const problem = completion.problems.find((entry) => entry.code === "verification.completion-unproven");
  assert.ok(problem, "the completion names the unproven criterion");
  assert.match(problem?.message ?? "", /runnable sample/);
});

test("#1371 the proof hash and schema keep the knowledge limitation", () => {
  const proof = createVerificationProof(proofInput("unknown", { evidence: "a dated source" }));
  // The plan entry the proof records carries the limitation, so an independent verifier can recompute the claim.
  assert.equal(proof.task.criteria[0]?.knowledge, "unknown");
  assert.equal(proof.task.criteria[0]?.needs?.evidence, "a dated source");
  assert.match(proof.proofHash, /^[0-9a-f]{64}$/);
  assert.equal(sha256("") === proof.proofHash, false);
});
