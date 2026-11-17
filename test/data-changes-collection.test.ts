import assert from "node:assert/strict";
import { test } from "node:test";
import { ids, pageAt, withSite } from "./data-record-site.ts";

const EVENTS = [
  '{"id":"aaaaaaaaaaaaaaaa","type":"added","record":"a","fields":{"title":"A"},"date":"2026-01-01"}',
  '{"id":"bbbbbbbbbbbbbbbb","type":"changed","record":"a","field":"title","old":"A","new":"B","date":"2026-02-01"}',
  '{"id":"cccccccccccccccc","type":"added","record":"b","fields":{"title":"B"},"date":"2026-02-01"}',
  '{"id":"dddddddddddddddd","type":"imported","record":"items","count":2,"date":"2026-03-01"}',
].join("\n");

const FILES = {
  "mizzen.yml": "collections:\n  items:\n    source: _data/items.yml\n",
  "_data/items.yml": "- id: a\n  title: Alpha\n- id: b\n  title: Beta\n",
  "data-changes/items.jsonl": `${EVENTS}\n`,
  "blog/index.md":
    "---\ntitle: Changes\nlist:\n  collection: items.changes\n  where: { type: changed }\n  fields: [type, record, date]\n---\n",
  "blog/grouped.md":
    "---\ntitle: Grouped changes\nlist:\n  collection: items.changes\n  group: type\n  fields: [type]\n---\n",
};

test("the history file loads as a read-only collection under <name>.changes", async () => {
  await withSite(FILES, (_root, result) => {
    assert.deepEqual(ids(result), []);
    const history = result.site.collections["items.changes"];
    assert.ok(history, "the collection is loaded");
    assert.equal(history.readonly, true);
    assert.equal(history.source, "data-changes/items.jsonl");
    assert.deepEqual(history.records.map((record) => record.id), [
      "aaaaaaaaaaaaaaaa",
      "bbbbbbbbbbbbbbbb",
      "cccccccccccccccc",
      "dddddddddddddddd",
    ]);
    assert.deepEqual(history.records[1]?.normalizedDates, { date: "2026-02-01" });
  });
});

test("a normal list filters and groups the events", async () => {
  await withSite(FILES, (_root, result) => {
    const filtered = pageAt(result, "/blog/")!;
    assert.deepEqual(filtered.list?.records.map((record) => record.id), ["bbbbbbbbbbbbbbbb"]);
    assert.deepEqual(filtered.list?.records.map((record) => record.fields), [
      { type: "changed", record: "a", date: "2026-02-01" },
    ]);

    const grouped = pageAt(result, "/blog/grouped/")!;
    assert.deepEqual(grouped.list?.groups.map((group) => [group.key, group.records.length]), [
      ["added", 2],
      ["changed", 1],
      ["imported", 1],
    ]);
  });
});

test("a bad history line is one error and the sound lines still load", async () => {
  await withSite(
    {
      ...FILES,
      "data-changes/items.jsonl": `${EVENTS}\nnot json\n`,
    },
    (_root, result) => {
      assert.deepEqual(ids(result), ["data.history-line"]);
      assert.equal(result.site.collections["items.changes"]?.records.length, 4);
    },
  );
});

test("a collection without a history file adds no collection and no page", async () => {
  await withSite(
    {
      "mizzen.yml": "collections:\n  items:\n    source: _data/items.yml\n",
      "_data/items.yml": "- id: a\n  title: Alpha\n",
    },
    (_root, result) => {
      assert.equal(result.site.collections["items.changes"], undefined);
      assert.equal(result.site.pages.some((page) => page.url.startsWith("/changes/")), false);
    },
  );
});
