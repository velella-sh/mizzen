import assert from "node:assert/strict";
import { test } from "node:test";
import type { TaskDocument, TaskStatus } from "../src/contracts/index.ts";
import {
  canCheck,
  canRead,
  canWrite,
  cancelTask,
  expireTask,
  transitionTask,
} from "../src/tasks/lifecycle.ts";
import { registered } from "./tasks-fixture.ts";

/** Moves a task that must allow the move, and returns it. */
function moved(task: TaskDocument, to: TaskStatus, result?: string): TaskDocument {
  const outcome = transitionTask(task, {
    to,
    reason: `Moved to ${to}.`,
    ...(result === undefined ? {} : { result }),
  });
  assert.deepEqual(outcome.problems, []);
  assert.ok(outcome.task);
  return outcome.task;
}

/** A task with a writer and checker plus two earlier transitions. */
function active(): TaskDocument {
  return moved(
    moved(
      registered({
        permissions: { read: ["*"], write: ["agent"], check: ["agent"] },
      }),
      "ready",
    ),
    "running",
  );
}

test("a canceled task keeps its prior events but cannot request writes or checks", () => {
  const before = active();
  const outcome = cancelTask(before, "The human withdrew the request.");
  assert.deepEqual(outcome.problems, []);
  assert.ok(outcome.task);
  const canceled = outcome.task;

  assert.equal(canceled.state, "canceled");
  assert.equal(canWrite(canceled, "agent"), false);
  assert.equal(canCheck(canceled, "agent"), false);
  assert.equal(canRead(canceled, "anyone"), true);

  assert.equal(canceled.events.length, before.events.length + 1);
  assert.deepEqual(canceled.events.slice(0, before.events.length), before.events);
  assert.deepEqual(canceled.events.at(-1), {
    sequence: before.events.length,
    taskId: before.id,
    snapshot: before.snapshot.id,
    from: "running",
    to: "canceled",
    reason: "The human withdrew the request.",
    result: null,
  });
});

test("an expired task cannot request writes or checks", () => {
  const before = moved(moved(registered({ permissions: { read: ["*"], write: ["*"], check: ["*"] } }), "ready"), "waiting");
  const outcome = expireTask(before, "The task expired before it ran.");

  assert.deepEqual(outcome.problems, []);
  assert.ok(outcome.task);
  assert.equal(outcome.task.state, "expired");
  assert.equal(canWrite(outcome.task, "anyone"), false);
  assert.equal(canCheck(outcome.task, "anyone"), false);
  assert.deepEqual(outcome.task.events.slice(0, -1), before.events);
});

test("an active task grants writes and checks by principal", () => {
  const task = active();
  assert.equal(canWrite(task, "agent"), true);
  assert.equal(canWrite(task, "someone-else"), false);
  assert.equal(canCheck(task, "agent"), true);
  assert.equal(canCheck(task, "someone-else"), false);
});

test("a wildcard grants writes and checks to any principal", () => {
  const task = moved(registered({ permissions: { read: ["*"], write: ["*"], check: ["*"] } }), "ready");
  assert.equal(canWrite(task, "anyone"), true);
  assert.equal(canCheck(task, "anyone"), true);
});

test("a draft does not write or check yet, even with permission", () => {
  const task = registered({ permissions: { read: ["*"], write: ["*"], check: ["*"] } });
  assert.equal(task.state, "draft");
  assert.equal(canWrite(task, "anyone"), false);
  assert.equal(canCheck(task, "anyone"), false);
});

test("a finished or failed task cannot request writes or checks", () => {
  const done = moved(moved(active(), "verify", "proof-1"), "done", "proof-1");
  assert.equal(done.state, "done");
  assert.equal(canWrite(done, "agent"), false);
  assert.equal(canCheck(done, "agent"), false);

  const failed = moved(moved(active(), "blocked"), "failed");
  assert.equal(canWrite(failed, "agent"), false);
  assert.equal(canCheck(failed, "agent"), false);
});

test("reading follows the read list and survives a terminal state", () => {
  const task = registered({ permissions: { read: ["alice"], write: [], check: [] } });
  assert.equal(canRead(task, "alice"), true);
  assert.equal(canRead(task, "bob"), false);

  const canceled = cancelTask(task, "Withdrawn.");
  assert.ok(canceled.task);
  assert.equal(canRead(canceled.task, "alice"), true);
  assert.equal(canWrite(canceled.task, "alice"), false);
});

test("a task cannot be canceled twice", () => {
  const canceled = moved(active(), "canceled");
  assert.equal(canceled.state, "canceled");
  const again = cancelTask(canceled, "Again.");
  assert.equal(again.task, undefined);
  assert.equal(again.problems[0]?.code, "task.transition");
});
