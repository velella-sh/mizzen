import assert from "node:assert/strict";
import { test } from "node:test";
import { compareStates } from "../src/data/changes/compare.ts";

const r = (id: string, fields: Record<string, unknown> = {}) => ({ id, fields });

test("an added and a removed record are listed by id", () => {
  const changes = compareStates([r("a"), r("b")], [r("b"), r("c")]);
  assert.deepEqual(changes, [{ type: "removed", record: "a" }, { type: "added", record: "c" }]);
});

test("a field change names the field with its old and new value", () => {
  const changes = compareStates([r("a", { title: "A", n: 1 })], [r("a", { title: "B", n: 1, extra: true })]);
  assert.deepEqual(changes, [
    { type: "changed", record: "a", field: "extra", new: true },
    { type: "changed", record: "a", field: "title", old: "A", new: "B" },
  ]);
});

test("a record named in another record's earlier ids is renamed, not removed and added", () => {
  const changes = compareStates([r("old", { t: 1 })], [r("new", { t: 2, aliases: ["old"] })], { aliases: "aliases" });
  assert.deepEqual(changes, [
    { type: "renamed", record: "new", from: "old" },
    { type: "changed", record: "new", field: "aliases", new: ["old"] },
    { type: "changed", record: "new", field: "t", old: 1, new: 2 },
  ]);
});

test("a reordered file records nothing", () => {
  assert.deepEqual(compareStates([r("a", { x: { b: 1, c: 2 } }), r("b")], [r("b"), r("a", { x: { c: 2, b: 1 } })]), []);
});

test("include leaves a field out", () => {
  assert.deepEqual(compareStates([r("a", { t: 1, u: 1 })], [r("a", { t: 2, u: 2 })], { include: (f) => f === "u" }).map((c) => c.field), ["u"]);
});
