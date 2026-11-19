import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { buildModel } from "../src/model/build.ts";
import { changelogFeeds } from "../src/data/changes/preset.ts";
import { feedLinks } from "../src/feeds/links.ts";
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

test("changelog layouts receive snapshot groups, affected record links, and the published Atom link", async () => {
  const history = [
    ...EVENTS.split("\n"),
    '{"id":"cccccccccccccccc","type":"renamed","record":"a","from":"old-a","date":"2026-02-02"}',
    '{"id":"dddddddddddddddd","type":"removed","record":"a","date":"2026-02-02"}',
  ].join("\n");
  const files = { ...FILES, "mizzen.yml": `base: /docs\n${FILES["mizzen.yml"]}`, "data-changes/items.jsonl": `${history}\n` };
  await withSite(files, (_root, result) => {
    assert.deepEqual(result.diagnostics, []);
    const newest = pageAt(result, "/docs/changes/items/")!;
    assert.deepEqual(newest.list?.groups.map((group) => group.key), ["2026-01-01", "2026-02-01", "2026-02-02"]);
    assert.deepEqual(newest.list?.groups[2]?.records.map((row) => [row.fields.type, row.links.record]).sort(), [
      ["removed", undefined], ["renamed", "/docs/items/a/"],
    ]);
    const feed = `https://example.test/docs/${changelogFeeds(result.site)[0]!.path}`;
    const dated = pageAt(result, "/docs/changes/items/2026-02-02/")!;
    for (const page of [newest, dated]) {
      assert.equal(page.list?.feed, feed);
      assert.deepEqual(feedLinks(result.site, page), [
        { rel: "alternate", href: feed, attrs: { type: "application/atom+xml", title: page.title } },
      ]);
      assert.equal(page.list?.records.find((row) => row.fields.type === "renamed")?.links.record, "/docs/items/a/");
    }
  });
  await withSite({ ...files, "mizzen.yml": files["mizzen.yml"].replace("url: https://example.test\n", "") }, (_root, result) => {
    const page = pageAt(result, "/docs/changes/items/")!;
    assert.equal(page.list?.feed, undefined);
    assert.deepEqual(feedLinks(result.site, page), []);
    assert.deepEqual(changelogFeeds(result.site), []);
  });
});

async function buildOnce(): Promise<{ root: string; site: Awaited<ReturnType<typeof buildModel>>["site"] }> {
  const root = tempSite(FILES);
  const result = await buildModel(root);
  assert.deepEqual(result.diagnostics, []);
  return { root, site: result.site };
}
