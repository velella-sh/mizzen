import assert from "node:assert/strict";
import { test } from "node:test";
import type { DataRecord, Page, Site, SiteConfig } from "../src/contracts/index.ts";
import type { OutputContext, OutputFile } from "../src/contracts/output.ts";
import { entryId } from "../src/feeds/id.ts";
import { feeds } from "../src/outputs/feeds.ts";

const pos = { file: "_data/releases.yml", startLine: 3, startColumn: 1, endLine: 7, endColumn: 1 };

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
    collections: { releases: { source: "_data/releases.yml" } },
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
    source: { file: "_templates/release.md", line: 1, column: 1, endLine: 1, endColumn: 1 },
    frontMatter: {},
    title: url,
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "",
    markdown: "",
    kind: "doc",
    record: {
      collection: "releases",
      id: recordId,
      position: pos,
      template: "_templates/release.md",
      templateLine: 1,
      fallbacks: [],
    },
  };
}

const ctx: OutputContext = {
  renderPage: () => Promise.reject(new Error("feeds render no page")),
  report: () => {},
};

async function ids(model: Site): Promise<string[]> {
  const files: readonly OutputFile[] = await feeds.run(model, ctx);
  return [...String(files[0]!.contents).matchAll(/<id>([^<]*)<\/id>/g)].map((match) => match[1] ?? "");
}

test("an entry id is a tag URI from the site host, the collection, and the record id", () => {
  assert.equal(entryId("https://example.test", "posts", "hello"), "tag:example.test:posts/hello");
  assert.equal(entryId("https://example.test:8443", "posts", "hello"), "tag:example.test:posts/hello");
  assert.equal(entryId("https://example.test", "posts", "a/b"), "tag:example.test:posts/a%2Fb");
});

test("an entry id survives a URL change", async () => {
  const make = (url: string): Site => ({
    config: config({ url: "https://example.test", feeds: { releases: { collection: "releases", date: "date" } } }),
    pages: [page(url, "v1")],
    nav: {},
    collections: { releases: { name: "releases", source: "_data/releases.yml", records: [record("v1", { date: "2026-01-01" })] } },
    data: {},
  });
  const before = await ids(make("/releases/v1/"));
  const after = await ids(make("/releases/version-one/"));
  assert.deepEqual(before, after);
  assert.deepEqual(before, ["tag:example.test:feeds/releases", "tag:example.test:releases/v1"]);
});

test("an idField makes a new event of the same record a new entry", async () => {
  const model: Site = {
    config: config({
      url: "https://example.test",
      feeds: { releases: { collection: "releases", date: "date", idField: "version" } },
    }),
    pages: [page("/releases/v1/", "v1")],
    nav: {},
    collections: {
      releases: { name: "releases", source: "_data/releases.yml", records: [record("v1", { date: "2026-01-01", version: "1.2.0" })] },
    },
    data: {},
  };
  assert.deepEqual(await ids(model), ["tag:example.test:feeds/releases", "tag:example.test:releases/v1/1.2.0"]);
});
