import assert from "node:assert/strict";
import { test } from "node:test";
import { headMeta } from "../src/outputs/head-meta.ts";
import { pageAt, withSite } from "./data-record-site.ts";

/** A site with three posts, a template, and a list of one post per page; `extra` adds to the collection and the list. */
function files(options: { url?: boolean; collection?: string; template?: string; list?: string } = {}): Record<string, string> {
  return {
    "mizzen.yml":
      (options.url === false ? "" : "url: https://example.com\n") +
      "collections:\n  posts:\n    source: _data/posts.yml\n    template: _templates/posts.md\n    permalink: /posts/{id}/\n" +
      (options.collection ?? ""),
    "_data/posts.yml":
      "- id: a\n  title: Alpha\n  home: https://elsewhere.test/alpha/\n- id: b\n  title: Beta\n  home: ''\n- id: c\n  title: Gamma\n",
    "_templates/posts.md": options.template ?? '---\ntitle: "{title}"\n---\n# :field[title]\n',
    "blog/index.md": `---\ntitle: Blog\nlist:\n  collection: posts\n  perPage: 1\n${options.list ?? ""}---\n# Blog\n`,
  };
}

const canonical = (head: ReturnType<typeof headMeta>): string[] =>
  head.links.filter((link) => link.rel === "canonical").map((link) => link.href);

test("each record page has its own canonical URL", async () => {
  await withSite(files(), (_root, result) => {
    for (const id of ["a", "b", "c"]) {
      const page = pageAt(result, `/posts/${id}/`)!;
      assert.deepEqual(canonical(headMeta(result.site, page, [])), [`https://example.com/posts/${id}/`]);
    }
  });
});

test("page two onwards of a list has its own canonical, not the first page's, even when the list names one", async () => {
  await withSite(files(), (_root, result) => {
    assert.deepEqual(canonical(headMeta(result.site, pageAt(result, "/blog/")!, [])), ["https://example.com/blog/"]);
    assert.deepEqual(canonical(headMeta(result.site, pageAt(result, "/blog/page/2/")!, [])), ["https://example.com/blog/page/2/"]);
  });
  const named = files();
  named["blog/index.md"] = named["blog/index.md"]!.replace("title: Blog\n", "title: Blog\ncanonical_url: https://example.com/blog/\n");
  await withSite(named, (_root, result) => {
    assert.deepEqual(canonical(headMeta(result.site, pageAt(result, "/blog/")!, [])), ["https://example.com/blog/"]);
    assert.deepEqual(canonical(headMeta(result.site, pageAt(result, "/blog/page/3/")!, [])), ["https://example.com/blog/page/3/"]);
  });
});

test("a record field overrides the canonical, front matter still wins, and an empty field changes nothing", async () => {
  await withSite(files({ collection: "    seo:\n      canonical: home\n" }), (_root, result) => {
    assert.deepEqual(canonical(headMeta(result.site, pageAt(result, "/posts/a/")!, [])), ["https://elsewhere.test/alpha/"]);
    assert.deepEqual(canonical(headMeta(result.site, pageAt(result, "/posts/b/")!, [])), ["https://example.com/posts/b/"]);
    assert.deepEqual(canonical(headMeta(result.site, pageAt(result, "/posts/c/")!, [])), ["https://example.com/posts/c/"]);
    assert.ok(headMeta(result.site, pageAt(result, "/posts/a/")!, []).meta.some((tag) => tag.name === "og:url" && tag.content === "https://elsewhere.test/alpha/"));
  });
  const withFrontMatter = files({
    collection: "    seo:\n      canonical: home\n",
    template: '---\ntitle: "{title}"\ncanonical_url: /posts/pinned/\n---\n# :field[title]\n',
  });
  await withSite(withFrontMatter, (_root, result) => {
    assert.deepEqual(canonical(headMeta(result.site, pageAt(result, "/posts/a/")!, [])), ["https://example.com/posts/pinned/"]);
  });
});

test("a site without url writes no canonical, with or without an override", async () => {
  await withSite(files({ url: false, collection: "    seo:\n      canonical: home\n" }), (_root, result) => {
    for (const url of ["/posts/a/", "/posts/b/", "/blog/page/2/"]) {
      assert.deepEqual(canonical(headMeta(result.site, pageAt(result, url)!, [])), [], url);
    }
    assert.ok(headMeta(result.site, pageAt(result, "/posts/a/")!, []).links.every((link) => link.rel !== "canonical"));
  });
});
