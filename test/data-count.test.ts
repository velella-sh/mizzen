import assert from "node:assert/strict";
import { test } from "node:test";
import { withSite } from "./data-record-site.ts";

const FILES = {
  "mizzen.yml": "collections:\n  posts:\n    source: _data/posts.yml\n",
  "_data/posts.yml": "- id: a\n  status: published\n- id: b\n  status: draft\n- id: c\n  status: published\n",
  "about.md": "---\ntitle: About\n---\nWe have :count{from=posts} posts and :count{from=posts where=\"status=published\"} published.\n",
};

test("a count shows all records, a filtered count, and writes the number into the twin", async () => {
  await withSite(FILES, (_root, result) => {
    assert.deepEqual(result.diagnostics, []);
    const page = result.site.pages.find((candidate) => candidate.url === "/about/")!;
    assert.match(page.html, /We have 3 posts and 2 published\./);
    assert.match(page.markdown, /We have 3 posts and 2 published\./);
  });
});

test("a count of an empty result is zero", async () => {
  await withSite(
    {
      ...FILES,
      "about.md": "---\ntitle: About\n---\n:count{from=posts where=\"status=archived\"}\n",
    },
    (_root, result) => {
      assert.deepEqual(result.diagnostics, []);
      assert.match(result.site.pages.find((candidate) => candidate.url === "/about/")!.html, />0</);
    },
  );
});

test("a count matches a list field the same way a list does, in HTML and in the twin", async () => {
  await withSite(
    {
      ...FILES,
      "_data/posts.yml": "- id: a\n  status: published\n  tags: [news]\n- id: b\n  status: draft\n  tags: [release]\n- id: c\n  status: published\n  tags: [news, release]\n",
      "about.md": "---\ntitle: About\n---\n:count{from=posts where=\"tags=news\"} news posts.\n",
    },
    (_root, result) => {
      assert.deepEqual(result.diagnostics, []);
      const page = result.site.pages.find((candidate) => candidate.url === "/about/")!;
      assert.match(page.html, />2 news posts\./);
      assert.match(page.markdown, /2 news posts\./);
    },
  );
});

test("an unknown collection and a malformed where are findings at the directive", async () => {
  await withSite(
    {
      ...FILES,
      "about.md": "---\ntitle: About\n---\n:count{from=missing}\n\n:count{from=posts where=\"broken\"}\n",
    },
    (_root, result) => {
      assert.deepEqual(result.diagnostics.map((finding) => finding.id), ["data.unknown-collection", "data.count-where"]);
      assert.ok(result.diagnostics.every((finding) => finding.pos?.file === "about.md"));
    },
  );
});
