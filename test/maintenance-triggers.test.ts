import assert from "node:assert/strict";
import { test } from "node:test";
import { taskSnapshot } from "../src/tasks/snapshot.ts";
import {
  maintenanceChanges,
  maintenanceTriggers,
  registerTriggerTasks,
  triggerKey,
} from "../src/maintenance/trigger.ts";

const snapshot = taskSnapshot({
  content: "a".repeat(64),
  data: "b".repeat(64),
  config: "c".repeat(64),
  tooling: "d".repeat(64),
});
const hash = (letter: string): string => letter.repeat(64);

test("changed covered files, schemas, APIs, and data become versioned triggers", () => {
  const changes = maintenanceChanges(
    { "src/api.ts": hash("a"), "schema/site.json": hash("b"), "catalog/one": hash("c"), "docs/api.md": hash("d") },
    { "src/api.ts": hash("e"), "schema/site.json": hash("9"), "catalog/one": hash("f") },
    (source) => (source.startsWith("schema/") ? "schema" : source.startsWith("catalog/") ? "data" : "file"),
  );
  assert.deepEqual(
    Object.fromEntries(changes.map((change) => [change.source, `${change.kind}:${change.change}`])),
    {
      "catalog/one": "data:changed",
      "docs/api.md": "file:removed",
      "schema/site.json": "schema:changed",
      "src/api.ts": "file:changed",
    },
  );

  const result = maintenanceTriggers([...changes, changes[0]!], snapshot);
  assert.deepEqual(result.problems, []);
  assert.equal(result.triggers.length, 4);
  assert.equal(result.duplicates.length, 1);
  for (const trigger of result.triggers) {
    assert.equal(trigger.version, 1);
    assert.equal(trigger.snapshot.id, snapshot.id);
    assert.match(trigger.id, /^[0-9a-f]{64}$/);
    assert.match(trigger.detail, /was (added|changed|removed)/);
  }
  assert.deepEqual(
    result.triggers.map((trigger) => trigger.kind),
    ["data", "file", "schema", "file"],
  );
});

test("repeating a trigger registers no duplicate task, and a new hash is a new task", () => {
  const trigger = maintenanceTriggers(
    [{ kind: "file", source: "src/api.ts", change: "changed", sha256: hash("a") }],
    snapshot,
  ).triggers[0]!;
  assert.equal(triggerKey(trigger), `maintenance:trigger:${trigger.id}`);

  const first = registerTriggerTasks([trigger]);
  assert.deepEqual(first.problems, []);
  assert.equal(first.tasks.length, 1);
  assert.equal(first.tasks[0]!.created, true);
  assert.equal(first.tasks[0]!.task.id, first.tasks[0]!.task.id);

  const again = registerTriggerTasks([trigger, trigger], { existing: [first.tasks[0]!.task] });
  assert.deepEqual(again.problems, []);
  assert.equal(again.tasks.length, 1);
  assert.equal(again.tasks[0]!.created, false);
  assert.equal(again.tasks[0]!.task.id, first.tasks[0]!.task.id);

  const changed = maintenanceTriggers(
    [{ kind: "file", source: "src/api.ts", change: "changed", sha256: hash("b") }],
    snapshot,
  ).triggers[0]!;
  assert.notEqual(changed.id, trigger.id);
  const second = registerTriggerTasks([changed], { existing: [first.tasks[0]!.task] });
  assert.equal(second.tasks[0]!.created, true);
  assert.notEqual(second.tasks[0]!.task.id, first.tasks[0]!.task.id);
});

test("a trigger names the changed resource in its task scope and acceptance", () => {
  const triggers = maintenanceTriggers(
    [
      { kind: "api", source: "build", change: "changed", sha256: hash("a") },
      { kind: "data", source: "catalog/one", change: "changed", sha256: hash("b") },
    ],
    snapshot,
  ).triggers;
  const tasks = registerTriggerTasks(triggers);
  assert.deepEqual(tasks.problems, []);
  const apiTask = tasks.tasks.find((entry) => entry.task.scope.symbols.includes("build"));
  const dataTask = tasks.tasks.find((entry) => entry.task.scope.collections.includes("catalog"));
  assert.ok(apiTask);
  assert.ok(dataTask);
  assert.deepEqual(apiTask.task.scope.files, []);
  assert.equal(apiTask.task.acceptance[0]!.check, "site");
});

test("an invalid trigger is refused with a path and a code", () => {
  const result = maintenanceTriggers(
    [
      { kind: "file", source: "src/api.ts", change: "changed" },
      { kind: "file", source: "../outside.ts", change: "changed", sha256: hash("a") },
      { kind: "file", source: "src/api.ts", change: "changed", sha256: "nope" },
    ],
    snapshot,
  );
  assert.equal(result.triggers.length, 0);
  assert.deepEqual(
    result.problems.map((problem) => problem.code),
    ["maintenance.trigger-hash", "maintenance.trigger-source", "maintenance.trigger-hash"],
  );
});
