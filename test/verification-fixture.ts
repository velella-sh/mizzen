import assert from "node:assert/strict";
import type { TaskDocument } from "../src/contracts/task.ts";
import type {
  VerificationCheck,
  VerificationHumanReview,
  VerificationOutputs,
  VerificationPlan,
  VerificationReferences,
} from "../src/contracts/verification.ts";
import { sha256 } from "../src/data/lock.ts";
import { planVerification, type VerificationCheckSpec } from "../src/verification/plan.ts";
import { createVerificationProof, type VerificationProofInput } from "../src/verification/proof.ts";
import { changeOf } from "../src/verification/scope.ts";
import { registerTask } from "../src/tasks/register.ts";

/** A minimal valid registered task with the criteria a test names. */
export function verificationTask(
  acceptance: readonly { id: string; statement: string; check?: string; review?: true }[] = [
    { id: "doctor", statement: "The doctor passes.", check: "doctor" },
  ],
  files: readonly string[] = ["docs/install.md"],
): TaskDocument {
  const result = registerTask(
    {
      version: 1,
      idempotencyKey: `verification-${acceptance.map((criterion) => criterion.id).join("-")}`,
      goal: "Verify the install guide",
      scope: { pages: [], blocks: [], collections: [], symbols: [], files },
      snapshot: {
        content: "a".repeat(64),
        data: "b".repeat(64),
        config: "c".repeat(64),
        tooling: "d".repeat(64),
      },
      budget: { contextTokens: 6000, toolCalls: 20, timeMs: 60000 },
      acceptance,
    },
    { checks: ["doctor", "test"] },
  );
  assert.deepEqual(result.problems, []);
  assert.ok(result.task);
  return result.task;
}

/** The specs a plan needs for the task's criteria. */
export function verificationSpecs(task: TaskDocument): VerificationCheckSpec[] {
  return task.acceptance.map((criterion) => {
    const check = criterion.check ?? "doctor";
    return {
      criterion: criterion.id,
      check,
      fixture: "docs/install.md",
      expected: `Check "${check}" passes and the fixture matches.`,
    };
  });
}

/** A complete plan for a task. */
export function verificationPlan(task: TaskDocument): VerificationPlan {
  const plan = planVerification(task, verificationSpecs(task));
  assert.deepEqual(plan.problems, []);
  return plan;
}

/** A passing check for one criterion. */
export function passedCheck(
  task: TaskDocument,
  criterion: string,
  id = "doctor",
  commit = "abc1234",
): VerificationCheck {
  return {
    id,
    criterion,
    task: task.id,
    snapshot: task.snapshot.id,
    commit,
    status: "passed",
    command: ["doctor", "."],
    outputHash: sha256("ok\n"),
    limits: { timeoutMs: 1000, memoryMb: 64, network: "deny", paths: "sandbox" },
  };
}

/** A review with no criteria, used when the task requires none. */
export const NO_REVIEW: VerificationHumanReview = { status: "not-required", criteria: [] };

/** Outputs that match exactly. */
export function matchingOutputs(): VerificationOutputs {
  const hash = "e".repeat(64);
  return {
    inputHash: "f".repeat(64),
    tool: { expected: "0.2.6", actual: "0.2.6" },
    expectedHash: hash,
    actualHash: hash,
    match: true,
    explained: [],
    unexplained: [],
  };
}

/** References that pass. */
export const NO_REFERENCES: VerificationReferences = {
  ok: true,
  removed: [],
  changed: [],
  invalid: [],
  issues: [],
};

/** The default proof input for the single-check task. */
export function proofInput(overrides: Partial<VerificationProofInput> = {}): VerificationProofInput {
  const task = verificationTask();
  return {
    task,
    plan: verificationPlan(task),
    commit: "abc1234",
    base: "def5678",
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

/** A proved proof for the single-check task. */
export function provedProof(overrides: Partial<VerificationProofInput> = {}) {
  return createVerificationProof(proofInput(overrides));
}
