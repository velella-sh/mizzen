import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import type { Plugin } from "../src/contracts/index.ts";
import { buildModel } from "../src/model/build.ts";
import { site } from "./data-record-site.ts";

const FILES = {
  "mizzen.yml": "collections:\n  posts:\n    source: _data/posts.yml\n",
  "_data/posts.yml":
    "- id: a\n  title: Alpha\n  tags: [news]\n" +
    "- id: b\n  title: Beta\n  tags: [news]\n" +
    "- id: c\n  title: Gamma\n  tags: [ui]\n",
  "blog/index.md":
    "---\ntitle: Blog\n" +
    "list:\n" +
    "  collection: posts\n" +
    "  sort: title\n" +
    "  perPage: 1\n" +
    '  expand: { field: tags, permalink: "/tags/{value|slug}/" }\n' +
    "---\n# Blog\n",
  "other.md": "---\ntitle: Other\n---\nOther page.\n",
};

test("every generated list page gets exactly one content hook and keeps its own URL as title", async () => {
  const root = site(FILES);
  const calls: string[] = [];
  const plugin: Plugin = {
    name: "title-from-url",
    content(page) {
      calls.push(page.url);
      return { ...page, title: page.url };
    },
  };
  try {
    const result = await buildModel(root, { plugins: [plugin] });
    assert.deepEqual(result.diagnostics, []);

    const generated = ["/blog/", "/tags/news/", "/tags/news/page/2/", "/tags/ui/"] as const;
    assert.deepEqual([...calls].sort(), ["/blog/", "/other/", "/tags/news/", "/tags/news/page/2/", "/tags/ui/"]);
    assert.equal(calls.length, new Set(calls).size, "no page is hooked twice");
    for (const url of generated) {
      assert.equal(calls.filter((called) => called === url).length, 1, `${url} is hooked once`);
      assert.equal(result.site.pages.find((page) => page.url === url)?.title, url);
    }
    assert.equal(result.site.pages.find((page) => page.url === "/other/")?.title, "/other/");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
