import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { buildModel } from "../src/model/build.ts";
import { changelogFeeds } from "../src/data/changes/preset.ts";
import { pageAt, site as tempSite, withSite } from "./data-record-site.ts";

const EVENTS = [
  '{"id":"aaaaaaaaaaaaaaaa","type":"added","record":"a","fields":{"title":"A"},"date":"2026-01-01"}',
  '{"id":"bbbbbbbbbbbbbbbb","type":"changed","record":"a","field":"title","old":"A","new":"A2","date":"2026-02-01"}',
].join("\n");

const FILES = {
  "mizzen.yml": [
    "title: Example",
    "url: https://example.test",
    "collections:",
    "  items:",
    "    source: _data/items.yml",
    "    template: _templates/item.md",
    "    permalink: /items/{id}/",
    "    changelog:",
    "      track: [title]",
    "      pages: true",
    "  other:",
    "    source: _data/other.yml",
    "    changelog:",
    "      pages: true",
    "",
  ].join("\n"),
  "_data/items.yml": "- id: a\n  title: A2\n",
  "_data/other.yml": "- id: x\n  title: X\n",
  "_templates/item.md": "---\ntitle: \"{title}\"\n---\n\n# :field[title]\n",
  "data-changes/items.jsonl": `${EVENTS}\n`,
};

test("changelog.pages builds a newest page and one page per snapshot date", async () => {
  await withSite(FILES, (_root, result) => {
    assert.deepEqual(result.diagnostics.map((finding) => finding.id), []);
    assert.deepEqual(
      result.site.pages.filter((page) => page.url.startsWith("/changes/")).map((page) => page.url),
      ["/changes/items/", "/changes/items/2026-02-01/", "/changes/items/2026-01-01/"].sort(),
    );
    assert.deepEqual(pageAt(result, "/changes/items/")?.list?.records.map((record) => record.id), [
      "bbbbbbbbbbbbbbbb",
      "aaaaaaaaaaaaaaaa",
    ]);
    assert.equal(pageAt(result, "/changes/other/"), undefined, "a collection with no history builds nothing");
  });
});

test("the Atom feed uses the event id as its entry id and is stable across builds", async () => {
  const first = await buildOnce();
  const second = await buildOnce();
  try {
    const feed = changelogFeeds(first.site)[0]!;
    assert.equal(feed.path, "feeds/items-changes.xml");
    const xml = String(feed.contents);
    const ids = [...xml.matchAll(/<id>([^<]*)<\/id>/g)].map((match) => match[1]!).filter((id) => !id.startsWith("tag:"));
    assert.deepEqual(ids, ["bbbbbbbbbbbbbbbb", "aaaaaaaaaaaaaaaa"]);
    assert.deepEqual(feed, changelogFeeds(second.site)[0]);
  } finally {
    for (const { root } of [first, second]) rmSync(root, { recursive: true, force: true });
  }
});

async function buildOnce(): Promise<{ root: string; site: Awaited<ReturnType<typeof buildModel>>["site"] }> {
  const root = tempSite(FILES);
  const result = await buildModel(root);
  assert.deepEqual(result.diagnostics, []);
  return { root, site: result.site };
}
