import assert from "node:assert/strict";
import { test } from "node:test";
import { registerTask } from "../src/tasks/register.ts";
import { taskIdOf } from "../src/tasks/identity.ts";
import { contractInput, registered } from "./tasks-fixture.ts";

const checks = ["doctor", "test"];

test("task and request ids are deterministic and do not depend on time or paths", () => {
  const first = registered();
  const second = registerTask(contractInput(), { checks });

  assert.match(first.id, /^[0-9a-f]{64}$/);
  assert.match(first.requestId, /^[0-9a-f]{64}$/);
  assert.equal(second.task?.id, first.id);
  assert.equal(second.task?.requestId, first.requestId);
  assert.equal(JSON.stringify(second.task), JSON.stringify(first));
});

test("the task id comes from the key and the request id from the contract", () => {
  assert.equal(registered().id, taskIdOf("install-1"));

  const one = registered({ goal: "Update the install guide" });
  const two = registered({ idempotencyKey: "install-2" });
  const changed = registered({ idempotencyKey: "install-2", goal: "Update the build guide" });

  assert.notEqual(two.id, one.id);
  assert.equal(two.requestId, one.requestId, "same content with another key is the same request");
  assert.notEqual(changed.requestId, one.requestId);
  assert.notEqual(changed.id, one.id);
});

test("registering the same content and key twice returns one task", () => {
  const first = registered();
  const again = registerTask(contractInput({ goal: "  Update the install guide  " }), {
    checks,
    existing: [first],
  });

  assert.deepEqual(again.problems, []);
  assert.equal(again.created, false);
  assert.equal(again.task?.id, first.id);
  assert.equal(JSON.stringify(again.task), JSON.stringify(first));
  assert.equal(again.task?.events.length, 1);
});

test("the same key with different content is refused as a conflict", () => {
  const first = registered();
  const conflict = registerTask(contractInput({ goal: "Update the build guide" }), {
    checks,
    existing: [first],
  });

  assert.equal(conflict.created, false);
  assert.equal(conflict.task, undefined);
  const [problem] = conflict.problems;
  assert.ok(problem);
  assert.equal(problem.path, "/idempotencyKey");
  assert.equal(problem.code, "task.idempotency-conflict");
  assert.match(problem.message, /already exists with different content/);
});

test("the first event records registration and its snapshot", () => {
  const task = registered();
  assert.equal(task.state, "draft");
  assert.deepEqual(task.events, [
    {
      sequence: 0,
      taskId: task.id,
      snapshot: task.snapshot.id,
      from: null,
      to: "draft",
      reason: "Task registered.",
      result: null,
    },
  ]);
});
