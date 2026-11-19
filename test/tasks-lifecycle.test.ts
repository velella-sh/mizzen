import assert from "node:assert/strict";
import { test } from "node:test";
import type { TaskDocument, TaskStatus } from "../src/contracts/index.ts";
import {
  canTransition,
  replayTask,
  TASK_TERMINAL_STATUSES,
  TASK_TRANSITIONS,
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
  assert.deepEqual(outcome.problems, [], `moving to ${to} should be allowed`);
  assert.ok(outcome.task);
  return outcome.task;
}

test("the eight working states have the documented allowed transitions", () => {
  assert.deepEqual(TASK_TRANSITIONS.draft, ["ready", "canceled", "expired"]);
  assert.deepEqual(TASK_TRANSITIONS.ready, ["running", "waiting", "blocked", "canceled", "expired"]);
  assert.deepEqual(TASK_TRANSITIONS.waiting, ["ready", "running", "blocked", "canceled", "expired"]);
  assert.deepEqual(TASK_TRANSITIONS.running, ["verify", "waiting", "blocked", "failed", "canceled", "expired"]);
  assert.deepEqual(TASK_TRANSITIONS.blocked, ["ready", "running", "waiting", "failed", "canceled", "expired"]);
  assert.deepEqual(TASK_TRANSITIONS.verify, ["done", "running", "failed", "canceled", "expired"]);
  for (const state of TASK_TERMINAL_STATUSES) {
    assert.deepEqual(TASK_TRANSITIONS[state], []);
    assert.equal(canTransition(state, "running"), false);
  }
});

test("a task moves from draft to verify and then to done, recording every event", () => {
  const task = registered();
  const ready = moved(task, "ready");
  const running = moved(ready, "running");
  const verify = moved(running, "verify", "proof-1");
  const done = moved(verify, "done", "proof-1");

  assert.equal(done.state, "done");
  assert.deepEqual(done.events.map((event) => [event.sequence, event.from, event.to]), [
    [0, null, "draft"],
    [1, "draft", "ready"],
    [2, "ready", "running"],
    [3, "running", "verify"],
    [4, "verify", "done"],
  ]);
  for (const event of done.events) {
    assert.equal(event.taskId, done.id);
    assert.equal(event.snapshot, task.snapshot.id);
    assert.notEqual(event.reason, "");
  }
  assert.equal(done.events[3]?.result, "proof-1");
  assert.equal(done.events[4]?.result, "proof-1");
  assert.equal(done.events[1]?.result, null);
  assert.equal(task.state, "draft", "the input document is not mutated");
});

test("verify and done require a result reference", () => {
  const running = moved(moved(registered(), "ready"), "running");
  const verify = transitionTask(running, { to: "verify", reason: "Checks passed." });
  assert.equal(verify.task, undefined);
  assert.equal(verify.problems[0]?.path, "/result");
  assert.equal(verify.problems[0]?.code, "task.result-required");

  const verifying = moved(running, "verify", "proof-1");
  const done = transitionTask(verifying, { to: "done", reason: "Checks passed." });
  assert.equal(done.task, undefined);
  assert.equal(done.problems[0]?.code, "task.result-required");
});

test("an illegal transition is rejected with the allowed states and changes nothing", () => {
  const task = registered();
  const illegal = transitionTask(task, { to: "done", reason: "Skip the work." });

  assert.equal(illegal.task, undefined);
  const [problem] = illegal.problems;
  assert.ok(problem);
  assert.equal(problem.path, "/state");
  assert.equal(problem.code, "task.transition");
  assert.match(problem.message, /from `draft` to `done`/);
  assert.match(problem.message, /`ready`/);
  assert.deepEqual(task.events, [task.events[0]]);
  assert.equal(task.state, "draft");
});

test("a terminal task cannot move anywhere", () => {
  const failed = moved(moved(moved(moved(registered(), "ready"), "running"), "blocked"), "failed");
  const move = transitionTask(failed, { to: "ready", reason: "Retry." });
  assert.equal(move.task, undefined);
  assert.match(move.problems[0]?.message ?? "", /terminal state/);
});

test("an empty reason or result is refused", () => {
  const task = registered();
  const noReason = transitionTask(task, { to: "ready", reason: "  " });
  assert.equal(noReason.problems[0]?.code, "task.reason-empty");

  const emptyResult = transitionTask(moved(task, "ready"), {
    to: "running",
    reason: "Start.",
    result: " ",
  });
  assert.equal(emptyResult.problems[0]?.code, "task.result-empty");
});

test("valid events replay to the same final state in the same order", () => {
  const done = moved(moved(moved(moved(registered(), "ready"), "running"), "verify", "proof-1"), "done", "proof-1");
  const first = replayTask(done.id, done.events);
  const second = replayTask(done.id, done.events);

  assert.deepEqual(first.problems, []);
  assert.equal(first.state, "done");
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("replay rejects a wrong task, a gap, a wrong snapshot, and an illegal move", () => {
  const done = moved(moved(moved(moved(registered(), "ready"), "running"), "verify", "proof-1"), "done", "proof-1");

  assert.equal(replayTask("0".repeat(64), done.events).problems[0]?.code, "task.event-task");

  const gap = done.events.map((event) => ({ ...event }));
  const third = gap[3];
  assert.ok(third);
  gap[3] = { ...third, sequence: 9 };
  assert.equal(replayTask(done.id, gap).problems[0]?.code, "task.event-sequence");

  const wrongSnapshot = done.events.map((event) => ({ ...event }));
  const second = wrongSnapshot[1];
  assert.ok(second);
  wrongSnapshot[1] = { ...second, snapshot: "f".repeat(64) };
  assert.equal(replayTask(done.id, wrongSnapshot).problems[0]?.code, "task.event-snapshot");

  const illegal = done.events.map((event) => ({ ...event }));
  const fifth = illegal[4];
  assert.ok(fifth);
  illegal[4] = { ...fifth, from: "draft", to: "done" };
  assert.equal(replayTask(done.id, illegal).problems[0]?.code, "task.event-from");
});

test("replay rejects an empty event list and a registration that starts elsewhere", () => {
  assert.equal(replayTask("0".repeat(64), []).problems[0]?.code, "task.event-empty");
  const task = registered();
  const registration = task.events[0];
  assert.ok(registration);
  assert.equal(replayTask(task.id, [{ ...registration, from: "ready" }]).problems[0]?.code, "task.event-from");
  assert.equal(replayTask(task.id, [{ ...registration, to: "ready" }]).problems[0]?.code, "task.event-registration");
});
