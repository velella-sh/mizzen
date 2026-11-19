import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import type { TaskDocument, TaskStatus } from "../src/contracts/index.ts";
import { acceptanceOutcomes } from "../src/tasks/acceptance.ts";
import { canCheck, canWrite, cancelTask, replayTask, transitionTask } from "../src/tasks/lifecycle.ts";
import { registerTask } from "../src/tasks/register.ts";

const schema = JSON.parse(
  readFileSync(new URL("../schema/task.schema.json", import.meta.url), "utf8"),
) as Record<string, unknown>;
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/tasks/lifecycle.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

// ajv is CommonJS: its default export is the class at run time, but its types name it.
const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

/** Registers the fixture and returns the task. */
function registered(key = "fixture-install-guide"): TaskDocument {
  const result = registerTask(
    { ...fixture, idempotencyKey: key },
    { checks: ["doctor", "test"] },
  );
  assert.deepEqual(result.problems, []);
  assert.ok(result.task);
  return result.task;
}

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

/** Validates a document against the public task schema, with a readable failure. */
function assertSchema(task: TaskDocument): void {
  assert.equal(validate(task), true, validate.errors?.map((error) => `${error.instancePath} ${error.message}`).join("; ") ?? "");
}

test("the fixture moves from draft to verify and then to done, matching the public schema", () => {
  const draft = registered();
  assert.equal(draft.state, "draft");
  assertSchema(draft);

  const ready = moved(draft, "ready");
  const running = moved(ready, "running");
  const verifying = moved(running, "verify", "proof-1");
  const done = moved(verifying, "done", "proof-1");

  assert.equal(done.state, "done");
  assertSchema(done);
  assert.deepEqual(replayTask(done.id, done.events), { state: "done", problems: [] });
  assert.deepEqual(done.events.map((event) => event.to), ["draft", "ready", "running", "verify", "done"]);
  assert.equal(done.events.every((event) => event.taskId === done.id), true);
  assert.equal(done.events.every((event) => event.snapshot === done.snapshot.id), true);

  const encoded = JSON.stringify(done);
  assert.equal(JSON.stringify(JSON.parse(encoded)), encoded);
});

test("the same fixture can be canceled and blocks new writes and checks", () => {
  const draft = registered("fixture-install-guide-canceled");
  const ready = moved(draft, "ready");
  const canceled = cancelTask(ready, "The human withdrew the request.");

  assert.deepEqual(canceled.problems, []);
  assert.ok(canceled.task);
  assert.equal(canceled.task.state, "canceled");
  assertSchema(canceled.task);
  assert.deepEqual(replayTask(canceled.task.id, canceled.task.events), { state: "canceled", problems: [] });
  assert.equal(canWrite(canceled.task, "agent"), false);
  assert.equal(canCheck(canceled.task, "agent"), false);
  assert.deepEqual(canceled.task.events.slice(0, ready.events.length), ready.events);
});

test("an illegal transition is rejected and leaves the document unchanged", () => {
  const draft = registered();
  const before = JSON.stringify(draft);
  const skip = transitionTask(draft, { to: "done", reason: "Skip the work.", result: "proof-1" });

  assert.equal(skip.task, undefined);
  assert.equal(skip.problems[0]?.code, "task.transition");
  assert.equal(JSON.stringify(draft), before);
});

test("the fixture is deterministic across two registrations", () => {
  const first = registered();
  const second = registered();
  assert.equal(JSON.stringify(second), JSON.stringify(first));
  assert.equal(first.requestId, second.requestId);
});

test("the fixture's acceptance criteria are proved only by matching evidence", () => {
  const task = registered();
  const evidence = new Map([
    ["doctor", { check: { id: "doctor", status: "passed" as const } }],
    ["review", { review: { status: "approved" as const } }],
  ]);

  assert.deepEqual(acceptanceOutcomes(task.acceptance, evidence), [
    { id: "doctor", outcome: "proved" },
    { id: "review", outcome: "proved" },
  ]);
  assert.deepEqual(acceptanceOutcomes(task.acceptance, new Map()), [
    { id: "doctor", outcome: "pending" },
    { id: "review", outcome: "needs-review" },
  ]);
});
