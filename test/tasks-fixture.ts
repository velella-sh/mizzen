import assert from "node:assert/strict";
import type { TaskDocument } from "../src/contracts/index.ts";
import { registerTask } from "../src/tasks/register.ts";

/** A minimal valid contract input, with the fields a test overrides. */
export function contractInput(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    idempotencyKey: "install-1",
    goal: "Update the install guide",
    scope: { pages: ["/guide/install/"] },
    snapshot: {
      content: "a".repeat(64),
      data: "b".repeat(64),
      config: "c".repeat(64),
      tooling: "d".repeat(64),
    },
    budget: { contextTokens: 6000, toolCalls: 20, timeMs: 60000 },
    acceptance: [{ id: "doctor", statement: "The doctor passes", check: "doctor" }],
    ...extra,
  };
}

/** Registers a task that must be valid, and returns it. */
export function registered(
  extra: Record<string, unknown> = {},
  existing: readonly TaskDocument[] = [],
): TaskDocument {
  const result = registerTask(contractInput(extra), {
    checks: ["doctor", "test"],
    existing,
  });
  assert.deepEqual(result.problems, []);
  assert.equal(result.created, true);
  assert.ok(result.task, "a valid registration has a task");
  return result.task;
}
