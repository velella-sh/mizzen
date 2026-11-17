/** #511: public records are read by project, collection, and stable id; private and duplicate targets are not. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { recordTargets } from "../../src/links/record-targets.ts";

test("a public project's records are targets by project, collection, and id", () => {
  const read = recordTargets([
    {
      project: "ebb",
      public: true,
      urls: { collections: { items: { tide: "/ebb/items/tide/", ebb: "/ebb/items/ebb/" } } },
    },
  ]);
  assert.deepEqual(read.diagnostics, []);
  assert.deepEqual(read.targets, [
    { project: "ebb", collection: "items", id: "ebb", url: "/ebb/items/ebb/" },
    { project: "ebb", collection: "items", id: "tide", url: "/ebb/items/tide/" },
  ]);
});

test("a private project's records are not targets", () => {
  const read = recordTargets([
    {
      project: "internal",
      public: false,
      urls: { collections: { items: { secret: "/internal/items/secret/" } } },
    },
  ]);
  assert.deepEqual(read.targets, []);
  assert.equal(read.diagnostics.length, 1);
  assert.equal(read.diagnostics[0]?.id, "network.record-private");
  assert.equal(read.diagnostics[0]?.severity, "error");
  assert.match(read.diagnostics[0]?.message ?? "", /internal/);
});

test("a duplicate project, collection, and id is rejected, and the other targets stand", () => {
  const read = recordTargets([
    {
      project: "ebb",
      public: true,
      urls: { collections: { items: { ebb: "/ebb/items/ebb/", tide: "/ebb/items/tide/" } } },
    },
    {
      project: "ebb",
      public: true,
      urls: { collections: { items: { ebb: "/ebb/items/ebb-renamed/" } } },
    },
  ]);
  assert.deepEqual(read.targets, [
    { project: "ebb", collection: "items", id: "tide", url: "/ebb/items/tide/" },
  ]);
  assert.equal(read.diagnostics.length, 1);
  assert.equal(read.diagnostics[0]?.id, "network.record-duplicate");
  assert.equal(read.diagnostics[0]?.severity, "error");
  assert.match(read.diagnostics[0]?.message ?? "", /ebb\/items\/ebb/);
});
