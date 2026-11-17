/** #512: a record reference resolves from locked targets, and an unknown or removed id is reported where it is written. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveRecordReference, type RecordReference } from "../../src/links/record-reference.ts";
import { recordTargets } from "../../src/links/record-targets.ts";

const pos = { file: "links.md", line: 7, column: 5, endLine: 7, endColumn: 25 };

/** The locked targets of one record, at the URL the map gives it. */
function targets(project: string, collection: string, id: string, url: string) {
  return recordTargets([{ project, public: true, urls: { collections: { [collection]: { [id]: url } } } }]).targets;
}

const reference: RecordReference = { project: "ebb", collection: "items", id: "ebb", pos };

test("a record reference resolves by id, so a rename reaches the current URL", () => {
  const found = resolveRecordReference(reference, {
    targets: targets("ebb", "items", "ebb", "/ebb/items/ebb-renamed/"),
    previous: targets("ebb", "items", "ebb", "/ebb/items/ebb/"),
  });
  assert.deepEqual(found.diagnostics, []);
  assert.equal(found.resolved?.url, "/ebb/items/ebb-renamed/");
});

test("an id no lock holds is reported at the reference's file and line", () => {
  const found = resolveRecordReference(reference, {
    targets: targets("ebb", "items", "tide", "/ebb/items/tide/"),
  });
  assert.equal(found.resolved, undefined);
  assert.equal(found.diagnostics.length, 1);
  assert.equal(found.diagnostics[0]?.id, "network.record-missing");
  assert.equal(found.diagnostics[0]?.severity, "error");
  assert.match(found.diagnostics[0]?.message ?? "", /ebb\/items\/ebb/);
  assert.equal(found.diagnostics[0]?.pos?.file, "links.md");
  assert.equal(found.diagnostics[0]?.pos?.line, 7);
});

test("a record an earlier lock held is reported as removed at the reference's file and line", () => {
  const found = resolveRecordReference(reference, {
    targets: targets("ebb", "items", "tide", "/ebb/items/tide/"),
    previous: targets("ebb", "items", "ebb", "/ebb/items/ebb/"),
  });
  assert.equal(found.resolved, undefined);
  assert.equal(found.diagnostics.length, 1);
  assert.equal(found.diagnostics[0]?.id, "network.record-removed");
  assert.equal(found.diagnostics[0]?.severity, "error");
  assert.match(found.diagnostics[0]?.message ?? "", /no longer published/);
  assert.match(found.diagnostics[0]?.message ?? "", /\/ebb\/items\/ebb\//);
  assert.equal(found.diagnostics[0]?.pos?.file, "links.md");
  assert.equal(found.diagnostics[0]?.pos?.line, 7);
});
