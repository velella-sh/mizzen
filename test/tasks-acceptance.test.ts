import assert from "node:assert/strict";
import { test } from "node:test";
import type { TaskAcceptanceCriterion, TaskCriterionEvidence } from "../src/contracts/index.ts";
import { acceptanceOutcomes, criterionOutcome } from "../src/tasks/acceptance.ts";
import { parseTaskContract } from "../src/tasks/contract.ts";
import { contractInput, registered } from "./tasks-fixture.ts";

const check: TaskAcceptanceCriterion = { id: "doctor", statement: "The doctor passes", check: "doctor" };
const review: TaskAcceptanceCriterion = { id: "review", statement: "A person reviewed the wording", review: true };

test("a passed check proves only the check it names", () => {
  assert.equal(criterionOutcome(check, { check: { id: "doctor", status: "passed" } }), "proved");
  assert.equal(criterionOutcome(check, { check: { id: "test", status: "passed" } }), "pending");
});

test("a failed check is failed and a skipped one is not proved", () => {
  assert.equal(criterionOutcome(check, { check: { id: "doctor", status: "failed" } }), "failed");
  assert.equal(criterionOutcome(check, { check: { id: "doctor", status: "skipped" } }), "pending");
});

test("a review criterion needs an approved human decision", () => {
  assert.equal(criterionOutcome(review, { review: { status: "approved" } }), "proved");
  assert.equal(criterionOutcome(review, { review: { status: "rejected" } }), "failed");
  assert.equal(criterionOutcome(review), "needs-review");
});

test("no evidence never becomes proved, even when it names another kind", () => {
  const evidence: TaskCriterionEvidence = { check: { id: "doctor", status: "passed" } };
  assert.equal(criterionOutcome(review, evidence), "needs-review");
  assert.equal(criterionOutcome(check), "pending");
});

test("outcomes are reported in contract order with one entry per criterion", () => {
  const evidence = new Map<string, TaskCriterionEvidence>([
    ["doctor", { check: { id: "doctor", status: "passed" } }],
  ]);
  assert.deepEqual(acceptanceOutcomes([check, review], evidence), [
    { id: "doctor", outcome: "proved" },
    { id: "review", outcome: "needs-review" },
  ]);
});

test("a contract refuses a check that does not exist", () => {
  const result = parseTaskContract(
    contractInput({ acceptance: [{ id: "lint", statement: "Lint passes", check: "lint" }] }),
    { checks: ["doctor", "test"] },
  );
  assert.equal(result.contract, undefined);
  const [problem] = result.problems;
  assert.ok(problem);
  assert.equal(problem.path, "/acceptance/0/check");
  assert.equal(problem.code, "task.acceptance-check-unknown");
  assert.match(problem.message, /`doctor`, `test`/);
});

test("a registered criterion keeps either a check or a review requirement", () => {
  const task = registered({
    acceptance: [
      { id: "doctor", statement: "The doctor passes", check: "doctor" },
      { id: "review", statement: "A person reviewed the wording", review: true },
    ],
  });
  assert.deepEqual(task.acceptance.map((criterion) => [criterion.id, criterion.check, criterion.review]), [
    ["doctor", "doctor", undefined],
    ["review", undefined, true],
  ]);
});
