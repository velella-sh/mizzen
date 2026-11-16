import assert from "node:assert/strict";
import { test } from "node:test";
import type { OutputContext } from "../src/contracts/index.ts";
import { headMeta } from "../src/outputs/head-meta.ts";
import { sitemap } from "../src/outputs/sitemap.ts";
import { pageAt, withSite } from "./data-record-site.ts";

const context: OutputContext = { renderPage: async () => "", report: () => {} };

function files(list = ""): Record<string, string> {
  return {
    "mizzen.yml":
      "url: https://example.com\ncollections:\n  posts:\n    source: _data/posts.yml\n    template: _templates/posts.md\n" +
      "    permalink: /posts/{id}/\n    seo:\n      noindex: hidden\n",
    "_data/posts.yml": "- id: a\n  title: Alpha\n  hidden: true\n- id: b\n  title: Beta\n  hidden: false\n- id: c\n  title: Gamma\n",
    "_templates/posts.md": '---\ntitle: "{title}"\n---\n# :field[title]\n',
    "blog/index.md": `---\ntitle: Blog\n${list}list:\n  collection: posts\n  perPage: 1\n---\n# Blog\n`,
  };
}

const robots = (head: ReturnType<typeof headMeta>): string[] => head.meta.filter((tag) => tag.name === "robots").map((tag) => tag.content);

async function locs(site: Parameters<typeof sitemap.run>[0]): Promise<string[]> {
  const files = await sitemap.run(site, context);
  return [...files[0]!.contents.toString().matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]!);
}

test("a marked record is noindex and out of the sitemap, an unmarked one is neither, and both are built", async () => {
  await withSite(files(), async (_root, result) => {
    assert.ok(pageAt(result, "/posts/a/"), "the page is still in the build");
    assert.deepEqual(robots(headMeta(result.site, pageAt(result, "/posts/a/")!, [])), ["noindex"]);
    assert.deepEqual(robots(headMeta(result.site, pageAt(result, "/posts/b/")!, [])), []);
    assert.deepEqual(robots(headMeta(result.site, pageAt(result, "/posts/c/")!, [])), []);
    const urls = await locs(result.site);
    assert.ok(!urls.includes("https://example.com/posts/a/"));
    assert.ok(urls.includes("https://example.com/posts/b/"));
    assert.ok(urls.includes("https://example.com/posts/c/"));
  });
});

test("page two onwards of a list is noindex only when the list asks", async () => {
  await withSite(files(), async (_root, result) => {
    assert.deepEqual(robots(headMeta(result.site, pageAt(result, "/blog/page/2/")!, [])), []);
    assert.ok((await locs(result.site)).includes("https://example.com/blog/page/2/"));
  });
  await withSite(files("noindex_pagination: true\n"), async (_root, result) => {
    assert.deepEqual(robots(headMeta(result.site, pageAt(result, "/blog/")!, [])), [], "page one stays indexable");
    assert.deepEqual(robots(headMeta(result.site, pageAt(result, "/blog/page/2/")!, [])), ["noindex"]);
    const urls = await locs(result.site);
    assert.ok(urls.includes("https://example.com/blog/"));
    assert.ok(!urls.includes("https://example.com/blog/page/2/"));
    assert.ok(pageAt(result, "/blog/page/2/"), "still built");
  });
});
