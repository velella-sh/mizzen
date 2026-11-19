import assert from "node:assert/strict";
import { test } from "node:test";
import { relatedTasks } from "../src/tasks/related.ts";
import { registered } from "./tasks-fixture.ts";

test("a shared snapshot is a duplicate with its reason", () => {
  const task = registered({ idempotencyKey: "a" });
  const [match] = relatedTasks([task], { snapshot: task.snapshot.id }, "anyone");

  assert.ok(match);
  assert.equal(match.id, task.id);
  assert.equal(match.redacted, false);
  assert.equal(match.goal, task.goal);
  assert.deepEqual(match.reasons, [{ kind: "duplicate", detail: "Same input snapshot." }]);
});

test("a shared scope reference is a dependency with its reason", () => {
  const task = registered({ idempotencyKey: "a", scope: { pages: ["/guide/install/"] } });
  const [match] = relatedTasks([task], { scope: task.scope }, "anyone");

  assert.ok(match);
  assert.deepEqual(match.reasons, [
    { kind: "dependent", detail: "Shares page `/guide/install/`." },
  ]);
});

test("a task that shares neither snapshot nor scope is not returned", () => {
  const task = registered({ idempotencyKey: "a", scope: { pages: ["/guide/install/"] } });
  assert.deepEqual(
    relatedTasks([task], { snapshot: "f".repeat(64), scope: { ...task.scope, pages: ["/other/"], blocks: [], collections: [], symbols: [], files: [] } }, "anyone"),
    [],
  );
  assert.deepEqual(relatedTasks([task], {}, "anyone"), []);
});

test("both a shared snapshot and shared scope report both reasons in a fixed order", () => {
  const task = registered({ idempotencyKey: "a", scope: { pages: ["/guide/install/"] } });
  const [match] = relatedTasks([task], { snapshot: task.snapshot.id, scope: task.scope }, "anyone");

  assert.ok(match);
  assert.deepEqual(match.reasons, [
    { kind: "duplicate", detail: "Same input snapshot." },
    { kind: "dependent", detail: "Shares page `/guide/install/`." },
  ]);
});

test("an unreadable task is found by identity but its content is not exposed", () => {
  const task = registered({
    idempotencyKey: "a",
    goal: "Secret rewrite",
    scope: { pages: ["/secret/"] },
    permissions: { read: ["alice"], write: [], check: [] },
  });

  const [bySnapshot] = relatedTasks([task], { snapshot: task.snapshot.id }, "bob");
  assert.ok(bySnapshot);
  assert.equal(bySnapshot.redacted, true);
  assert.equal(bySnapshot.goal, undefined);
  assert.equal(bySnapshot.scope, undefined);
  assert.equal(JSON.stringify(bySnapshot).includes("Secret rewrite"), false);
  assert.equal(JSON.stringify(bySnapshot).includes("/secret/"), false);

  const [byScope] = relatedTasks([task], { scope: task.scope }, "bob");
  assert.ok(byScope);
  assert.deepEqual(byScope.reasons, [{ kind: "dependent", detail: "Shares scope with the query." }]);
  assert.equal(JSON.stringify(byScope).includes("/secret/"), false);
});

test("the reader named by the task sees its content", () => {
  const task = registered({
    idempotencyKey: "a",
    goal: "Secret rewrite",
    permissions: { read: ["alice"], write: [], check: [] },
  });
  const [match] = relatedTasks([task], { snapshot: task.snapshot.id }, "alice");
  assert.ok(match);
  assert.equal(match.redacted, false);
  assert.equal(match.goal, "Secret rewrite");
});

test("matches are sorted by task id", () => {
  const first = registered({ idempotencyKey: "a" });
  const second = registered({ idempotencyKey: "b" });

  const matches = relatedTasks([first, second], { snapshot: first.snapshot.id }, "anyone");
  assert.deepEqual(matches.map((match) => match.id), [first.id, second.id].sort());
  assert.equal(matches.length, 2);
});
