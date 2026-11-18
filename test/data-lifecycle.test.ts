import assert from "node:assert/strict";
import { test } from "node:test";
import type { CollectionLifecycleConfig } from "../src/contracts/index.ts";
import { lifecycleOf } from "../src/data/lifecycle.ts";

const CONFIG: CollectionLifecycleConfig = {
  states: ["published", "deprecated", "retired"],
  retired: ["retired"],
  replacement: "replacedBy",
  url: "redirect",
  machine: true,
};

test("a valid state is read with the config's URL policy", () => {
  const lifecycle = lifecycleOf({ id: "a", state: "deprecated" }, CONFIG);
  assert.deepEqual(lifecycle, {
    state: "deprecated",
    retired: false,
    replacementId: undefined,
    url: "redirect",
    machine: true,
    diagnostics: [],
  });
});

test("a record without a state keeps its behavior", () => {
  const lifecycle = lifecycleOf({ id: "old", title: "Old" }, undefined);
  assert.deepEqual(lifecycle, {
    state: undefined,
    retired: false,
    replacementId: undefined,
    url: "retain",
    machine: false,
    diagnostics: [],
  });
});

test("an unknown state is a warning and does not retire the record", () => {
  const lifecycle = lifecycleOf({ id: "a", state: "draft" }, CONFIG);
  assert.equal(lifecycle.state, "draft");
  assert.equal(lifecycle.retired, false);
  assert.deepEqual(lifecycle.diagnostics.map(({ id, severity }) => ({ id, severity })), [
    { id: "lifecycle.invalid-state", severity: "warning" },
  ]);
});

test("a retired record that redirects needs a replacement", () => {
  const lifecycle = lifecycleOf({ id: "a", state: "retired" }, CONFIG);
  assert.equal(lifecycle.retired, true);
  assert.equal(lifecycle.replacementId, undefined);
  assert.deepEqual(lifecycle.diagnostics.map(({ id, severity }) => ({ id, severity })), [
    { id: "lifecycle.replacement-missing", severity: "error" },
  ]);
});

test("a record cannot replace itself", () => {
  const lifecycle = lifecycleOf({ id: "a", state: "retired", replacedBy: "a" }, CONFIG);
  assert.deepEqual(lifecycle.diagnostics.map(({ id, severity }) => ({ id, severity })), [
    { id: "lifecycle.replacement-self", severity: "error" },
  ]);
});

test("a replacement id is read from its field", () => {
  const lifecycle = lifecycleOf({ id: "a", state: "retired", replacedBy: "b" }, CONFIG);
  assert.equal(lifecycle.replacementId, "b");
  assert.deepEqual(lifecycle.diagnostics, []);
});
