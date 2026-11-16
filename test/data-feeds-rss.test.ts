import assert from "node:assert/strict";
import { test } from "node:test";
import type { DataRecord, Page, Site, SiteConfig } from "../src/contracts/index.ts";
import type { OutputContext, OutputFile } from "../src/contracts/output.ts";
import { feeds } from "../src/outputs/feeds.ts";

const pos = { file: "_data/posts.yml", startLine: 3, startColumn: 1, endLine: 7, endColumn: 1 };

function config(overrides: Partial<SiteConfig> = {}): SiteConfig {
  return {
    title: "Example & Co",
    description: "A test site.",
    base: "/docs",
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

function page(url: string, recordId: string): Page {
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
    record: {
      collection: "posts",
      id: recordId,
      position: pos,
      template: "_templates/post.md",
      templateLine: 1,
      fallbacks: [],
    },
  };
}

function site(overrides: Partial<SiteConfig> = {}, records: readonly DataRecord[] = [], pages: readonly Page[] = []): Site {
  return {
    config: config(overrides),
    pages,
    nav: {},
    collections: { posts: { name: "posts", source: "_data/posts.yml", records } },
    data: {},
  };
}

const ctx: OutputContext = {
  renderPage: () => Promise.reject(new Error("feeds render no page")),
  report: () => {},
};

async function run(model: Site): Promise<readonly OutputFile[]> {
  return feeds.run(model, ctx);
}

const records = [
  record("a", { title: "A & B", published: "2026-03-01T09:30:00+03:30", summary: "First <one>." }),
  record("b", { title: "B", published: "2026-02-01" }),
];
const pages = [page("/docs/posts/a/", "a"), page("/docs/posts/b/", "b")];

test("RSS writes one item per entry with RFC 822 dates in UTC and a permanent guid", async () => {
  const files = await run(
    site(
      { url: "https://example.test", feeds: { posts: { collection: "posts", date: "published", formats: ["rss"] } } },
      records,
      pages,
    ),
  );
  assert.deepEqual(files.map((file) => file.path), ["feeds/posts.rss.xml"]);
  const xml = String(files[0]!.contents);
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<rss version="2\.0">/);
  assert.match(xml, /<title>Example &amp; Co<\/title>/);
  assert.match(xml, /<link>https:\/\/example\.test\/docs\/<\/link>/);
  assert.match(xml, /<description>A test site\.<\/description>/);
  assert.match(xml, /<lastBuildDate>Sun, 01 Mar 2026 06:00:00 GMT<\/lastBuildDate>/);
  assert.match(xml, /<item>\n {6}<title>A &amp; B<\/title>/);
  assert.match(xml, /<guid isPermaLink="false">tag:example\.test:posts\/a<\/guid>/);
  assert.match(xml, /<pubDate>Sun, 01 Mar 2026 06:00:00 GMT<\/pubDate>/);
  assert.match(xml, /<description>First &lt;one&gt;\.<\/description>/);
  assert.match(xml, /<item>\n {6}<title>B<\/title>/);
  assert.ok(!xml.includes("xmlns:"), "no vendor namespace is added");
});

test("JSON Feed 1.1 writes fixed keys, a trailing newline, and the selected fields under _mizzen", async () => {
  const files = await run(
    site(
      {
        url: "https://example.test",
        feeds: {
          posts: {
            collection: "posts",
            date: "published",
            formats: ["json"],
            fields: ["published", "title", "missing"],
          },
        },
      },
      records,
      pages,
    ),
  );
  assert.deepEqual(files.map((file) => file.path), ["feeds/posts.json"]);
  const text = String(files[0]!.contents);
  assert.ok(text.endsWith("\n"));
  const body = JSON.parse(text) as {
    version: string;
    title: string;
    home_page_url: string;
    feed_url: string;
    items: ReadonlyArray<Record<string, unknown>>;
  };
  assert.equal(body.version, "https://jsonfeed.org/version/1.1");
  assert.equal(body.title, "Example & Co");
  assert.equal(body.home_page_url, "https://example.test/docs/");
  assert.equal(body.feed_url, "https://example.test/docs/feeds/posts.json");
  assert.deepEqual(Object.keys(body.items[0]!), ["id", "url", "title", "content_text", "date_published", "_mizzen"]);
  assert.deepEqual(body.items[0]!._mizzen, { published: "2026-03-01T09:30:00+03:30", title: "A & B" });
  assert.equal(body.items[1]!.date_published, "2026-02-01T00:00:00.000Z");
  assert.deepEqual(body.items[1]!._mizzen, { published: "2026-02-01", title: "B" });
});

test("the same feed can be written in every declared format, sorted by path", async () => {
  const files = await run(
    site(
      { url: "https://example.test", feeds: { posts: { collection: "posts", date: "published", formats: ["rss", "atom", "json"] } } },
      records,
      pages,
    ),
  );
  assert.deepEqual(
    files.map((file) => file.path),
    ["feeds/posts.json", "feeds/posts.rss.xml", "feeds/posts.xml"],
  );
});
