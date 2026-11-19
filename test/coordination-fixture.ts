import assert from "node:assert/strict";
import type { CoordinationPlan } from "../src/contracts/coordination.ts";
import type { TaskDocument } from "../src/contracts/task.ts";
import { registerTask } from "../src/tasks/register.ts";
import { splitSubtasks } from "../src/coordination/split.ts";

/** Fixed hashes so every id in a coordination test is stable. */
export function fixtureParent(): TaskDocument {
  const result = registerTask(
    {
      version: 1,
      idempotencyKey: "parent-install",
      goal: "Update the install guide and its example",
      scope: { pages: ["guide/install"], files: ["examples/install.md"] },
      snapshot: {
        content: "a".repeat(64),
        data: "b".repeat(64),
        config: "c".repeat(64),
        tooling: "d".repeat(64),
      },
      budget: { contextTokens: 1000, toolCalls: 20, timeMs: 60_000 },
      permissions: { read: ["agent-parent"], write: ["agent-parent"], check: ["agent-parent"] },
      acceptance: [{ id: "guide-built", statement: "The guide builds.", check: "check.build" }],
    },
    { checks: ["check.build"] },
  );
  assert.ok(result.task);
  return result.task;
}

/** A plan with a guide subtask and an example that depends on it. */
export function fixturePlan(): CoordinationPlan {
  const result = splitSubtasks(fixtureParent(), [
    {
      key: "guide",
      owner: "agent-guide",
      goal: "Rewrite the install steps",
      scope: { pages: ["guide/install"], blocks: ["install-steps"] },
      acceptance: [{ id: "guide-check", statement: "The guide builds.", check: "check.build" }],
      budget: { contextTokens: 500, toolCalls: 10, timeMs: 30_000 },
    },
    {
      key: "example",
      owner: "agent-example",
      goal: "Update the install example",
      scope: { files: ["examples/install.md"] },
      acceptance: [{ id: "example-review", statement: "A person reviewed it.", review: true }],
      dependsOn: ["guide"],
      budget: { contextTokens: 400, toolCalls: 8, timeMs: 20_000 },
    },
  ]);
  assert.deepEqual(result.problems, []);
  return result.plan!;
}

/** The plan's subtask with the given key. */
export function subtaskOf(plan: CoordinationPlan, key: string) {
  const subtask = plan.subtasks.find((row) => row.key === key);
  assert.ok(subtask);
  return subtask;
}
