import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import type { DataRecord, Page, Site, SiteConfig } from "../src/contracts/index.ts";
import type { OutputContext } from "../src/contracts/output.ts";
import { pageJson } from "../src/outputs/page-json.ts";

const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;
const schema = JSON.parse(readFileSync(new URL("../schema/page-json.schema.json", import.meta.url), "utf8")) as object;
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

const pos = { file: "_data/posts.yml", startLine: 3, startColumn: 1, endLine: 7, endColumn: 1 };

function config(overrides: Partial<SiteConfig> = {}): SiteConfig {
  return {
    title: "Example",
    base: "",
    lang: "en",
    dir: "ltr",
    languages: [],
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

function record(id: string, fields: Record<string, unknown>): DataRecord {
  return { id, fields, position: pos, fieldPositions: {} };
}

function page(url: string, overrides: Partial<Page> = {}): Page {
  return {
    url,
    source: { file: "_templates/post.md", line: 1, column: 1, endLine: 1, endColumn: 1 },
    frontMatter: {},
    title: url,
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "",
    markdown: "",
    kind: "doc",
    ...overrides,
  };
}

function recordPage(url: string, id: string, overrides: Partial<Page> = {}): Page {
  return page(url, {
    record: { collection: "posts", id, position: pos, template: "_templates/post.md", templateLine: 1, fallbacks: [] },
    ...overrides,
  });
}

function site(records: readonly DataRecord[], pages: readonly Page[], overrides: Partial<SiteConfig> = {}): Site {
  return {
    config: config(overrides),
    pages,
    nav: {},
    collections: { posts: { name: "posts", source: "_data/posts.yml", records } },
    data: {},
  };
}

const ctx: OutputContext = {
  renderPage: () => Promise.reject(new Error("page JSON renders no page")),
  report: () => {},
};

async function bodies(model: Site): Promise<Array<{ path: string; body: Record<string, unknown> }>> {
  const files = await pageJson.run(model, ctx);
  return files.map((file) => ({ path: file.path, body: JSON.parse(String(file.contents)) as Record<string, unknown> }));
}

test("a record page carries its collection, id, and every field by default", async () => {
  const model = site(
    [record("hello", { title: "Hello", published: "2026-01-01", tags: ["a", "b"] })],
    [recordPage("/posts/hello/", "hello")],
  );
  const [file] = await bodies(model);
  assert.deepEqual(file!.body.record, {
    collection: "posts",
    id: "hello",
    fields: { title: "Hello", published: "2026-01-01", tags: ["a", "b"] },
  });
  assert.equal(validate(file!.body), true, JSON.stringify(validate.errors));
});

test("a collection's json.fields keeps only the named fields, in the page's language", async () => {
  const model = site(
    [
      record("hello", {
        title: { en: "Hello", fa: "سلام" },
        status: "stable",
        secret: "hidden",
      }),
    ],
    [recordPage("/posts/hello/", "hello", { lang: "fa" })],
    { collections: { posts: { source: "_data/posts.yml", json: { fields: ["title", "status"] } } } },
  );
  const [file] = await bodies(model);
  assert.deepEqual((file!.body.record as { fields: unknown }).fields, { title: "سلام", status: "stable" });
});

test("a record page whose record is gone carries no record object", async () => {
  const [file] = await bodies(site([], [recordPage("/posts/gone/", "gone")]));
  assert.ok(!("record" in file!.body));
});

test("a stale page carries its review date and changed files and validates against the schema", async () => {
  const stalePage = page("/guide/install/", {
    stale: {
      reviewed: "2026-03-01",
      files: [
        { path: "src/config.ts", change: "changed" },
        { path: "src/gone.ts", change: "removed" },
      ],
    },
  });
  const [file] = await bodies(site([], [stalePage]));
  assert.deepEqual(file!.body.stale, {
    reviewed: "2026-03-01",
    files: [
      { path: "src/config.ts", change: "changed" },
      { path: "src/gone.ts", change: "removed" },
    ],
  });
  assert.equal(validate(file!.body), true, JSON.stringify(validate.errors));
});

test("a page without a stale state carries no stale object", async () => {
  const [file] = await bodies(site([], [page("/guide/install/")]));
  assert.ok(!("stale" in file!.body));
});

test("a list page carries its record ids, groups, and pagination and validates against the schema", async () => {
  const listPage = page("/posts/", {
    list: {
      collection: "posts",
      records: [
        { collection: "posts", id: "a", url: "/posts/a/", fields: {}, links: {} },
        { collection: "posts", id: "b", url: "/posts/b/", fields: {}, links: {} },
      ],
      groups: [
        {
          key: "stable",
          count: 2,
          url: "/tags/stable/",
          records: [
            { collection: "posts", id: "a", url: "/posts/a/", fields: {}, links: {} },
            { collection: "posts", id: "b", url: "/posts/b/", fields: {}, links: {} },
          ],
        },
      ],
      pagination: { page: 1, total: 2, next: "/posts/page/2/" },
    },
  });
  const [file] = await bodies(site([], [listPage]));
  assert.deepEqual(file!.body.list, {
    collection: "posts",
    records: ["a", "b"],
    groups: [{ key: "stable", count: 2, url: "/tags/stable/", records: ["a", "b"] }],
    pagination: { page: 1, total: 2, next: "/posts/page/2/" },
  });
  assert.equal(validate(file!.body), true, JSON.stringify(validate.errors));
});

test("every page JSON the docs fixture writes validates against the published schema", async () => {
  const { buildModel } = await import("../src/model/build.ts");
  const root = fileURLToPath(new URL("../fixtures/docs-site", import.meta.url));
  const { site: model } = await buildModel(root);
  for (const file of await bodies(model)) {
    assert.equal(validate(file.body), true, `${file.path}: ${JSON.stringify(validate.errors)}`);
  }
});
