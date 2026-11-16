import assert from "node:assert/strict";
import { test } from "node:test";
import type { DataRecord, Page, Site, SiteConfig } from "../src/contracts/index.ts";
import type { Diagnostic } from "../src/contracts/diagnostic.ts";
import type { OutputContext, OutputFile } from "../src/contracts/output.ts";
import { feeds } from "../src/outputs/feeds.ts";

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
    collections: { posts: { source: "_data/posts.yml", dates: ["published"] } },
    feeds: {},
    defaults: [],
    theme: { options: {} },
    search: {},
    redirects: {},
    outputs: {},
    ...overrides,
  };
}

function record(id: string, fields: Record<string, unknown>, dates?: Record<string, string>): DataRecord {
  return { id, fields, position: pos, fieldPositions: {}, ...(dates === undefined ? {} : { normalizedDates: dates }) };
}

function page(url: string, recordId?: string): Page {
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
    ...(recordId === undefined
      ? {}
      : {
          record: {
            collection: "posts",
            id: recordId,
            position: pos,
            template: "_templates/post.md",
            templateLine: 1,
            fallbacks: [],
          },
        }),
  };
}

function site(overrides: Partial<SiteConfig> = {}, records?: readonly DataRecord[], pages?: readonly Page[]): Site {
  const cfg = config(overrides);
  return {
    config: cfg,
    pages: pages ?? [],
    nav: {},
    collections: { posts: { name: "posts", source: "_data/posts.yml", records: records ?? [] } },
    data: {},
  };
}

function context(): { ctx: OutputContext; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  return {
    diagnostics,
    ctx: { renderPage: () => Promise.reject(new Error("feeds render no page")), report: (d) => diagnostics.push(d) },
  };
}

async function run(model: Site): Promise<{ files: readonly OutputFile[]; diagnostics: readonly Diagnostic[] }> {
  const { ctx, diagnostics } = context();
  return { files: await feeds.run(model, ctx), diagnostics };
}

test("the output is named after its file", () => {
  assert.equal(feeds.name, "feeds");
});

test("an Atom feed lists the collection's dated records newest first, with tag ids and absolute links", async () => {
  const records = [
    record("b", { title: "B", published: "2026-02-01", summary: "Second." }),
    record("a", { title: "A", published: "2026-03-01", description: "First." }),
    record("d", { title: "D", published: "2026-03-01" }),
    record("c", { title: "C" }),
  ];
  const pages = records.map((r) => page(`/posts/${r.id}/`, r.id));
  const model = site(
    { url: "https://example.test", feeds: { posts: { collection: "posts", date: "published" } } },
    records,
    pages,
  );
  const { files, diagnostics } = await run(model);
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(files.map((file) => file.path), ["feeds/posts.xml"]);
  const xml = String(files[0]!.contents);

  assert.match(xml, /<link href="https:\/\/example\.test\/feeds\/posts\.xml" rel="self" type="application\/atom\+xml"\/>/);
  assert.match(xml, /<updated>2026-03-01T00:00:00\.000Z<\/updated>/);
  assert.deepEqual(
    [...xml.matchAll(/<title>([^<]*)<\/title>/g)].map((match) => match[1]),
    ["Example", "A", "D", "B"],
    "the feed title, then entries newest first, ties by id",
  );
  assert.ok(!xml.includes("C"), "a record without a date is left out");
  assert.match(xml, /<id>tag:example\.test:posts\/a<\/id>/);
  assert.match(xml, /<link href="https:\/\/example\.test\/posts\/a\/" rel="alternate" type="text\/html"\/>/);
  assert.match(xml, /<summary>First\.<\/summary>/);
  assert.match(xml, /<summary>Second\.<\/summary>/);
});

test("the feed is limited, filtered, and titled by its config", async () => {
  const records = [
    record("a", { title: "A", published: "2026-01-01", status: "stable" }),
    record("b", { title: "B", published: "2026-02-01", status: "draft" }),
    record("c", { title: "C", published: "2026-03-01", status: "stable" }),
  ];
  const model = site(
    {
      url: "https://example.test",
      feeds: {
        posts: {
          collection: "posts",
          date: "published",
          where: { status: "stable" },
          limit: 1,
          title: "Stable posts",
        },
      },
    },
    records,
    records.map((r) => page(`/posts/${r.id}/`, r.id)),
  );
  const xml = String((await run(model)).files[0]!.contents);
  assert.match(xml, /<title>Stable posts<\/title>/);
  assert.ok(xml.includes(">C<"));
  assert.ok(!xml.includes(">A<"), "the limit keeps the newest stable record");
  assert.ok(!xml.includes(">B<"), "the where filter leaves a draft out");
});

test("the same model always writes the same bytes, and the date never comes from the clock", async () => {
  const records = [record("a", { title: "A", published: "2026-01-01" })];
  const model = site(
    { url: "https://example.test", feeds: { posts: { collection: "posts", date: "published" } } },
    records,
    [page("/posts/a/", "a")],
  );
  const first = await run(model);
  const second = await run(model);
  assert.deepEqual(first.files, second.files);
});

test("a feed with no dated record writes no file", async () => {
  const model = site(
    { url: "https://example.test", feeds: { posts: { collection: "posts", date: "published" } } },
    [record("a", { title: "A" })],
    [page("/posts/a/", "a")],
  );
  assert.deepEqual((await run(model)).files, []);
});

test("a record without a main page is left out", async () => {
  const model = site(
    { url: "https://example.test", feeds: { posts: { collection: "posts", date: "published" } } },
    [record("a", { title: "A", published: "2026-01-01" })],
    [],
  );
  assert.deepEqual((await run(model)).files, []);
});

test("a site without a url reports the missing url once and writes no feed", async () => {
  const model = site(
    { feeds: { posts: { collection: "posts", date: "published" } } },
    [record("a", { title: "A", published: "2026-01-01" })],
    [page("/posts/a/", "a")],
  );
  const { files, diagnostics } = await run(model);
  assert.deepEqual(files, []);
  assert.deepEqual(
    diagnostics.map((d) => [d.id, d.severity]),
    [["feeds.no-url", "warning"]],
  );
});

test("a feed that names an unknown collection writes no file; the config loader reports it", async () => {
  const model = site(
    { url: "https://example.test", feeds: { posts: { collection: "missing", date: "published" } } },
    [],
    [],
  );
  const { files, diagnostics } = await run(model);
  assert.deepEqual(files, []);
  assert.deepEqual(diagnostics, []);
});

test("normalized dates decide an entry's date", async () => {
  const model = site(
    { url: "https://example.test", feeds: { posts: { collection: "posts", date: "published" } } },
    [record("a", { title: "A", published: "written differently" }, { published: "2026-04-05" })],
    [page("/posts/a/", "a")],
  );
  const xml = String((await run(model)).files[0]!.contents);
  assert.match(xml, /<updated>2026-04-05T00:00:00\.000Z<\/updated>/);
});
