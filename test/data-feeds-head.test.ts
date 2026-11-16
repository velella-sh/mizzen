import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { DataRecord, Page, Site, SiteConfig } from "../src/contracts/index.ts";
import { build } from "../src/pipeline/build.ts";
import { headMeta } from "../src/outputs/head-meta.ts";

const pos = { file: "guide.md", line: 1, column: 1, endLine: 1, endColumn: 1 };
const recordPos = { file: "_data/posts.yml", startLine: 3, startColumn: 1, endLine: 7, endColumn: 1 };

function config(overrides: Partial<SiteConfig> = {}): SiteConfig {
  return {
    title: "Example",
    url: "https://example.test",
    base: "",
    lang: "en",
    dir: "ltr",
    languages: [],
    source: ".",
    include: [],
    exclude: [],
    navigation: "_data/navigation.yml",
    collections: { posts: { source: "_data/posts.yml" }, notes: { source: "_data/notes.yml" } },
    feeds: {
      posts: { collection: "posts", date: "published", formats: ["atom", "json"] },
      other: { collection: "notes", date: "date" },
    },
    defaults: [],
    theme: { options: {} },
    search: {},
    redirects: {},
    outputs: {},
    ...overrides,
  };
}

function page(url: string, overrides: Partial<Page> = {}): Page {
  return {
    url,
    source: pos,
    frontMatter: {},
    title: "Page",
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "",
    markdown: "",
    kind: "doc",
    ...overrides,
  };
}

function recordPage(collection: string, id: string, url: string): Page {
  return page(url, {
    record: { collection, id, position: recordPos, template: `_templates/${collection}.md`, templateLine: 1, fallbacks: [] },
  });
}

function entry(id: string, field: string): DataRecord {
  return { id, fields: { title: id, [field]: "2026-01-01" }, position: recordPos, fieldPositions: {} };
}

/** A site whose `posts` and `notes` each hold one dated record with a page, so both declared feeds are written. */
function site(cfg: SiteConfig = config()): Site {
  return {
    config: cfg,
    pages: [recordPage("posts", "hello", "/posts/hello/"), recordPage("notes", "a", "/notes/a/")],
    nav: {},
    collections: {
      posts: { name: "posts", source: "_data/posts.yml", records: [entry("hello", "published")] },
      notes: { name: "notes", source: "_data/notes.yml", records: [entry("a", "date")] },
    },
    data: {},
  };
}

test("a record page advertises its collection's feeds with the right media types", () => {
  const record = page("/posts/hello/", {
    record: { collection: "posts", id: "hello", position: recordPos, template: "_templates/post.md", templateLine: 1, fallbacks: [] },
  });
  const head = headMeta(site(), record, []);
  const alternates = head.links.filter((link) => link.rel === "alternate");
  assert.deepEqual(
    alternates.map((link) => [link.href, link.attrs?.type, link.attrs?.title]),
    [
      ["https://example.test/feeds/posts.xml", "application/atom+xml", "Example"],
      ["https://example.test/feeds/posts.json", "application/feed+json", "Example"],
    ],
  );
});

test("a list page advertises its collection's feeds, absolute and under base", () => {
  const list = page("/posts/", {
    list: {
      collection: "posts",
      records: [],
      groups: [],
      pagination: { page: 1, total: 1 },
    },
  });
  const head = headMeta(site(config({ url: "https://example.test", base: "/docs" })), list, []);
  assert.deepEqual(
    head.links.filter((link) => link.rel === "alternate").map((link) => link.href),
    ["https://example.test/docs/feeds/posts.xml", "https://example.test/docs/feeds/posts.json"],
  );
});

test("an ordinary page, a view of another collection, and a file page advertise no feed", () => {
  const ordinary = headMeta(site(), page("/guide/install/"), []);
  assert.deepEqual(ordinary.links.filter((link) => link.rel === "alternate"), []);

  const other = recordPage("notes", "a", "/notes/a/");
  assert.deepEqual(
    headMeta(site(), other, []).links.filter((link) => link.rel === "alternate").map((link) => link.href),
    ["https://example.test/feeds/other.xml"],
  );

  const file = page("/download.zip");
  assert.deepEqual(headMeta(site(), file, []).links.filter((link) => link.rel === "alternate"), []);
});

test("a site without feeds writes no alternate link", () => {
  const head = headMeta(site(config({ feeds: {} })), page("/posts/hello/"), []);
  assert.deepEqual(head.links.filter((link) => link.rel === "alternate"), []);
});

test("a real build writes the feed, and the record page's head points at it", async () => {
  const root = mkdtempSync(join(tmpdir(), "feeds-site-"));
  const out = mkdtempSync(join(tmpdir(), "feeds-out-"));
  const theme = fileURLToPath(new URL("../../lateen", import.meta.url));
  const files: Record<string, string> = {
    "mizzen.yml": [
      "title: Example",
      "url: https://example.test",
      "base: /docs",
      "collections:",
      "  posts:",
      "    source: _data/posts.yml",
      "    id: id",
      "    template: _templates/post.md",
      "    permalink: /posts/{id}/",
      "    dates: [published]",
      "feeds:",
      "  posts:",
      "    collection: posts",
      "    date: published",
      "    formats: [atom, rss, json]",
      "",
    ].join("\n"),
    "_data/posts.yml": "- id: hello\n  title: Hello\n  published: 2026-01-01\n",
    "_templates/post.md": "---\ntitle: Hello post\nlayout: doc\n---\n\n# Hello post\n",
  };
  try {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    const result = await build({ root, out, themeRoot: theme, defaultLayout: "doc" });
    assert.deepEqual(result.diagnostics.filter((d) => d.severity === "error"), []);

    const html = readFileSync(join(out, "posts/hello/index.html"), "utf8");
    assert.match(html, /<link[^>]*href="https:\/\/example\.test\/docs\/feeds\/posts\.xml"[^>]*>/);
    assert.match(html, /<link[^>]*type="application\/feed\+json"[^>]*>/);
    for (const file of ["feeds/posts.xml", "feeds/posts.rss.xml", "feeds/posts.json"]) {
      assert.ok(readFileSync(join(out, file), "utf8").length > 0, `${file} was written`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});
