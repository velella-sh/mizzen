import assert from "node:assert/strict";
import { test } from "node:test";
import { ids, pageAt, withSite } from "./data-record-site.ts";

const EVENTS = [
  '{"id":"aaaaaaaaaaaaaaaa","type":"added","record":"old-a","fields":{"title":"A"},"date":"2025-01-01"}',
  '{"id":"bbbbbbbbbbbbbbbb","type":"renamed","record":"a","from":"old-a","date":"2025-02-01"}',
  '{"id":"cccccccccccccccc","type":"changed","record":"a","field":"title","old":"A","new":"A2","date":"2025-03-01"}',
].join("\n");

const FILES = {
  "mizzen.yml":
    "collections:\n  items:\n    source: _data/items.yml\n    template: _templates/item.md\n    permalink: /items/{id}/\n",
  "_data/items.yml": "- id: a\n  title: A2\n- id: b\n  title: B\n",
  "_templates/item.md": "---\ntitle: \"{title}\"\n---\n\n## History\n\n:::changes\n- :field[type] :field[record]\n:::\n",
  "data-changes/items.jsonl": `${EVENTS}\n`,
};

test("a record shows its own events, newest first, and follows an earlier id", async () => {
  await withSite(FILES, (_root, result) => {
    assert.deepEqual(ids(result), []);
    const page = pageAt(result, "/items/a/")!;
    assert.deepEqual(page.record?.changes?.map((event) => event.id), [
      "cccccccccccccccc",
      "bbbbbbbbbbbbbbbb",
      "aaaaaaaaaaaaaaaa",
    ]);
    assert.match(page.markdown, /- changed a\n- renamed a\n- added old-a/);
  });
});

test("a record without events gets no changes and renders no block", async () => {
  await withSite(
    {
      ...FILES,
      "_data/items.yml": "- id: b\n  title: B\n",
      "data-changes/items.jsonl": `${EVENTS}\n`,
    },
    (_root, result) => {
      const page = pageAt(result, "/items/b/")!;
      assert.equal(page.record?.changes, undefined);
      assert.doesNotMatch(page.markdown, /added b/);
    },
  );
});

test("a template without :::changes never reads the history", async () => {
  await withSite(
    {
      ...FILES,
      "_templates/item.md": "---\ntitle: \"{title}\"\n---\n\n# :field[title]\n",
    },
    (_root, result) => {
      assert.deepEqual(ids(result), []);
      assert.equal(pageAt(result, "/items/a/")?.record?.changes, undefined);
    },
  );
});
