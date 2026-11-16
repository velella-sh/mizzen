import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "../src/pipeline/build.ts";

const theme = fileURLToPath(new URL("../../lateen", import.meta.url));

interface Built {
  readonly out: string;
  readonly html: string;
  readonly llms: string;
  readonly collection: { records: { page: string | null }[] };
  readonly pageJson: Record<string, unknown>;
}

/** Builds a one-collection site; `config` is the lines of `mizzen.yml` after the shared header. */
async function built(config: readonly string[], posts: string, check: (site: Built) => void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "links-site-"));
  const out = mkdtempSync(join(tmpdir(), "links-out-"));
  const files: Record<string, string> = {
    "mizzen.yml": [
      "title: Example",
      "base: /docs",
      "collections:",
      "  posts:",
      "    source: _data/posts.yml",
      "    id: id",
      "    template: _templates/post.md",
      "    permalink: /posts/{id}/",
      "    dates: [published]",
      ...config,
      "",
    ].join("\n"),
    "_data/posts.yml": posts,
    "_templates/post.md": "---\ntitle: Post\nlayout: doc\n---\n\n# Post\n",
  };
  try {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    const result = await build({ root, out, themeRoot: theme, defaultLayout: "doc" });
    assert.deepEqual(result.diagnostics.filter((d) => d.severity === "error"), []);
    const read = (path: string): string => (existsSync(join(out, path)) ? readFileSync(join(out, path), "utf8") : "");
    check({
      out,
      html: read("posts/hello/index.html"),
      llms: read("llms.txt"),
      collection: JSON.parse(read("data/posts.json") || '{"records":[]}') as Built["collection"],
      pageJson: existsSync(join(out, "posts/hello/index.json")) ? { present: true } : {},
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
}

const dated = "- id: hello\n  title: Hello\n  published: 2026-01-01\n";
const feed = ["feeds:", "  posts:", "    collection: posts", "    date: published", "    formats: [atom, rss, json]"];
const alternates = (html: string): string[] =>
  [...html.matchAll(/<link[^>]*rel="alternate"[^>]*href="([^"]*)"[^>]*>|<link[^>]*href="([^"]*)"[^>]*rel="alternate"[^>]*>/g)]
    .map((m) => m[1] ?? m[2] ?? "")
    .filter((href) => /\/feeds\//.test(href));

test("every advertised feed and Data URL exists in the output", async () => {
  await built(["url: https://example.test", ...feed], dated, ({ out, html, llms, collection }) => {
    const hrefs = alternates(html);
    assert.equal(hrefs.length, 3);
    for (const href of hrefs) {
      assert.ok(existsSync(join(out, href.replace("https://example.test/docs/", ""))), `${href} exists`);
    }
    for (const [, url] of llms.matchAll(/\]\(https:\/\/example\.test\/docs\/(data\/[^)]*)\)/g)) {
      assert.ok(existsSync(join(out, url!)), `${url} exists`);
    }
    assert.ok(collection.records.every((r) => r.page !== null));
  });
});

test("a site without a valid url advertises no feed, because none is written", async () => {
  for (const url of [[], ["url: https://bad host"]]) {
    await built([...url, ...feed], dated, ({ out, html }) => {
      assert.deepEqual(alternates(html), []);
      assert.ok(!existsSync(join(out, "feeds/posts.xml")));
    });
  }
});

test("a feed with no eligible dated entry advertises nothing, because no file is written", async () => {
  await built(["url: https://example.test", ...feed], "- id: hello\n  title: Hello\n", ({ out, html }) => {
    assert.deepEqual(alternates(html), []);
    assert.ok(!existsSync(join(out, "feeds/posts.xml")));
  });
});

test("a feed whose where matches no record advertises nothing", async () => {
  await built(["url: https://example.test", ...feed, "    where:", "      title: nothing"], dated, ({ out, html }) => {
    assert.deepEqual(alternates(html), []);
    assert.ok(!existsSync(join(out, "feeds/posts.xml")));
  });
});

test("outputs.feeds: false leaves no alternate link and no feed", async () => {
  await built(["url: https://example.test", ...feed, "outputs:", "  feeds: false"], dated, ({ out, html }) => {
    assert.deepEqual(alternates(html), []);
    assert.ok(!existsSync(join(out, "feeds/posts.xml")));
  });
});

test("outputs.collection-json: false leaves no Data link in llms.txt", async () => {
  await built(["url: https://example.test", "outputs:", "  collection-json: false"], dated, ({ out, llms }) => {
    assert.ok(llms.length > 0);
    assert.ok(!llms.includes("## Data"));
    assert.ok(!llms.includes("data/posts.json"));
    assert.ok(!existsSync(join(out, "data/posts.json")));
  });
});

test("outputs.page-json: false writes page: null in collection JSON and no page JSON", async () => {
  await built(["url: https://example.test", "outputs:", "  page-json: false"], dated, ({ collection, pageJson }) => {
    assert.equal(collection.records.length, 1);
    assert.deepEqual(collection.records.map((r) => r.page), [null]);
    assert.deepEqual(pageJson, {});
  });
});
