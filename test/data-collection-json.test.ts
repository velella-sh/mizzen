import assert from "node:assert/strict";
import { test } from "node:test";
import type { DataRecord, Page, Site, SiteConfig } from "../src/contracts/index.ts";
import type { OutputContext } from "../src/contracts/output.ts";
import { collectionJson } from "../src/outputs/collection-json.ts";
import { llms } from "../src/outputs/llms.ts";

const pos = { file: "_data/posts.yml", startLine: 3, startColumn: 1, endLine: 7, endColumn: 1 };

function config(overrides: Partial<SiteConfig> = {}): SiteConfig {
  return {
    title: "Example",
    url: "https://example.test",
    base: "/docs",
    lang: "en",
    dir: "ltr",
    languages: [
      { code: "en", name: "English", prefix: "" },
      { code: "fa", name: "فارسی", prefix: "/fa" },
    ],
    source: ".",
    include: [],
    exclude: [],
    navigation: "_data/navigation.yml",
    collections: { posts: { source: "_data/posts.yml" } },
    feeds: {},
    defaults: [],
    theme: { options: {} },
    search: {},
    redirects: {},
    outputs: {},
    ...overrides,
  };
}

function record(id: string): DataRecord {
  return { id, fields: { title: id }, position: pos, fieldPositions: {} };
}

function page(url: string, id: string, lang = "en"): Page {
  return {
    url,
    source: { file: "_templates/post.md", line: 1, column: 1, endLine: 1, endColumn: 1 },
    frontMatter: {},
    title: id,
    lang,
    dir: lang === "fa" ? "rtl" : "ltr",
    headings: [],
    html: "",
    markdown: "",
    kind: "doc",
    record: { collection: "posts", id, position: pos, template: "_templates/post.md", templateLine: 1, fallbacks: [] },
  };
}

function site(pages: readonly Page[], overrides: Partial<SiteConfig> = {}): Site {
  return {
    config: config(overrides),
    pages,
    nav: {},
    collections: { posts: { name: "posts", source: "_data/posts.yml", records: [record("b"), record("a")] } },
    data: {},
  };
}

const ctx: OutputContext = {
  renderPage: () => Promise.reject(new Error("these outputs render no page")),
  report: () => {},
};

test("collection JSON lists every record's id, URL, and page JSON address, sorted by id", async () => {
  const files = await collectionJson.run(
    site([page("/docs/posts/b/", "b"), page("/docs/fa/posts/a/", "a", "fa"), page("/docs/posts/a/", "a")]),
    ctx,
  );
  assert.deepEqual(files.map((file) => file.path), ["data/posts.json"]);
  const body = JSON.parse(String(files[0]!.contents)) as unknown;
  assert.deepEqual(body, {
    collection: "posts",
    records: [
      { id: "a", url: "/docs/posts/a/", page: "/docs/posts/a/index.json" },
      { id: "b", url: "/docs/posts/b/", page: "/docs/posts/b/index.json" },
    ],
  });
  assert.ok(String(files[0]!.contents).endsWith("\n"));
});

test("collection JSON is one file per declared collection, sorted, and leaves out a record without a page", async () => {
  const model = site([page("/docs/posts/a/", "a")], {
    collections: {
      posts: { source: "_data/posts.yml" },
      notes: { source: "_data/notes.yml" },
    },
  });
  assert.deepEqual(
    (await collectionJson.run(model, ctx)).map((file) => file.path),
    ["data/notes.json", "data/posts.json"],
  );
  const notes = JSON.parse(String((await collectionJson.run(model, ctx))[0]!.contents)) as { records: unknown[] };
  assert.deepEqual(notes.records, []);
});

test("llms.txt links each collection's JSON under a Data section", async () => {
  const files = await llms.run(site([page("/docs/posts/a/", "a")]), ctx);
  const text = String(files[0]!.contents);
  assert.match(text, /## Data\n\n- \[posts\]\(https:\/\/example\.test\/docs\/data\/posts\.json\): 1 record\n/);
});

test("a site without collections writes no Data section", async () => {
  const text = String((await llms.run(site([], { collections: {} }), ctx))[0]!.contents);
  assert.ok(!text.includes("## Data"));
});
