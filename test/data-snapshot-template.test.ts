import assert from "node:assert/strict";
import { test } from "node:test";
import { snapshotText } from "../src/data/snapshot.ts";
import { ids, pageAt, withSite } from "./data-record-site.ts";

const LOCK =
  '{"snapshots":{"items":{"capturedAt":"2026-03-01T23:30:00Z","ref":"abc1234","source":"_data/items.yml","tool":"git","toolVersion":"2.45.0"}},"sources":{},"version":1}\n';

const FILES = {
  "mizzen.yml":
    "lang: en\nlanguages:\n  - code: en\n    name: English\n    prefix: \"\"\n  - code: fa\n    name: Persian\n    prefix: /fa\n  - code: de\n    name: Deutsch\n    prefix: /de\ncollections:\n  items:\n    source: _data/items.yml\n    template: _templates/items.md\n    permalink: /items/{id}/\n",
  "_data/items.yml": "- id: a\n  title: A\n",
  "_templates/items.md":
    "---\ntitle: \"{id}\"\nlayout: record\n---\nAs of :snapshot[capturedAt] at :snapshot[ref] from :snapshot[source] by :snapshot[tool] :snapshot[toolVersion].\n",
  "mizzen.lock.json": LOCK,
};

test("each snapshot field renders, and the date follows the page language", async () => {
  await withSite(FILES, (_root, result) => {
    assert.deepEqual(ids(result), []);
    const en = pageAt(result, "/items/a/")!;
    assert.match(en.markdown, /As of March 1, 2026 at abc1234 from _data\/items\.yml by git 2\.45\.0\./);
    const de = pageAt(result, "/de/items/a/");
    assert.ok(de);
    assert.match(de.markdown, /1\. März 2026/);
  });
});

test("the date is formatted in the language's own calendar", () => {
  const snapshot = { source: "s", capturedAt: "2026-03-01" };
  assert.match(snapshotText(snapshot, "capturedAt", "en")!, /March 1, 2026/);
  assert.match(snapshotText(snapshot, "capturedAt", "de")!, /1\. März 2026/);
  assert.match(snapshotText(snapshot, "capturedAt", "fa")!, /۱۴۰۴|1404/, "Persian uses the Persian calendar");
  assert.equal(snapshotText(snapshot, "ref", "en"), undefined, "a field the lock does not hold prints nothing");
  assert.equal(snapshotText(undefined, "capturedAt", "en"), undefined);
});

test("a collection with no snapshot renders nothing, and a bad field name is an error", async () => {
  const { "mizzen.lock.json": _lock, ...bare } = FILES;
  await withSite(bare, (_root, result) => {
    assert.deepEqual(ids(result), []);
    assert.match(pageAt(result, "/items/a/")!.markdown, /As of {2}at {2}from {2}by {2}\./);
  });
  await withSite(
    { ...FILES, "_templates/items.md": "---\ntitle: \"{id}\"\nlayout: record\n---\n:snapshot[when]\n" },
    (_root, result) => {
      assert.ok(ids(result).length > 0 && ids(result).every((id) => id === "data.snapshot-field"));
    },
  );
});
