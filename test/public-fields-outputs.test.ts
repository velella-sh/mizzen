import assert from "node:assert/strict";
import { test } from "node:test";
import type { Collection, DataRecord, Page, Site, SiteConfig } from "../src/contracts/index.ts";
import type { OutputContext } from "../src/contracts/output.ts";
import { apiCollections } from "../src/api/model.ts";
import { openApiDocument } from "../src/api/openapi.ts";
import { rawFiles } from "../src/data/raw.ts";
import { feedEntries } from "../src/feeds/entries.ts";
import { pageJson } from "../src/outputs/page-json.ts";
import { filterPlan, searchableRecords } from "../src/outputs/search-shared.ts";
import { publicChangeEvent } from "../src/data/public.ts";

const pos = { file: "_data/people.yml", startLine: 3, startColumn: 1, endLine: 7, endColumn: 1 };

function record(id: string, fields: Record<string, unknown>, derived?: Record<string, unknown>): DataRecord {
  return { id, fields: { id, ...fields }, position: pos, fieldPositions: {}, ...(derived === undefined ? {} : { derived }) };
}

const ada = record(
  "ada",
  {
    title: "Ada",
    summary: "Mathematician",
    date: "2024-01-01",
    secret: "canary-value",
    author: { name: "Ada", email: "ada@example.test" },
  },
  { daysLeft: 3, internalScore: 9 },
);

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
    collections: {
      people: {
        source: "_data/people.yml",
        template: "_templates/person.md",
        permalink: "/people/{id}/",
        dates: ["date"],
        public: ["title", "summary", "date", "author.name", "daysLeft"],
      },
    },
    feeds: {},
    defaults: [],
    theme: { options: {} },
    search: {},
    redirects: {},
    outputs: {},
    ...overrides,
  };
}

function page(url: string, id: string): Page {
  return {
    url,
    source: { file: "_templates/person.md", line: 1, column: 1, endLine: 1, endColumn: 1 },
    frontMatter: {},
    title: id,
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "<p>Ada</p>",
    markdown: "Ada",
    kind: "doc",
    record: { collection: "people", id, position: pos, template: "_templates/person.md", templateLine: 1, fallbacks: [] },
  };
}

function site(overrides: Partial<SiteConfig> = {}): Site {
  const collections: Record<string, Collection> = {
    people: { name: "people", source: "_data/people.yml", records: [ada] },
  };
  return { config: config(overrides), pages: [page("/people/ada/", "ada")], nav: {}, collections, data: {} };
}

const ctx: OutputContext = { renderPage: () => Promise.reject(new Error("no render")), report: () => {} };

test("raw JSON and CSV downloads publish only the public record view", () => {
  const raw = rawFiles(site().collections.people!, config().collections.people);
  assert.ok(raw);
  assert.equal(raw.json.includes("canary-value"), false);
  assert.equal(raw.json.includes("ada@example.test"), false);
  assert.equal(raw.json.includes("internalScore"), false);
  assert.equal(raw.csv.includes("canary-value"), false);
  assert.match(raw.json, /"author": \{\n\s+"name": "Ada"/);
  // Raw files carry source fields only; derived values stay in pages and props.
  assert.equal(raw.json.includes("daysLeft"), false);
  assert.match(raw.csv, /Ada/);
});

test("the API collection, its records, and its OpenAPI document omit blocked fields", () => {
  const apiSite = site({
    api: { version: "v1", collections: { people: { fields: ["id", "title", "secret", "author"] } } },
  });
  const collections = apiCollections(apiSite);
  assert.deepEqual(collections[0]!.fields, ["id", "title"]);
  assert.deepEqual(collections[0]!.records[0]!.fields, { id: "ada", title: "Ada" });
  const openapi = JSON.stringify(openApiDocument(apiSite, collections, new Map()));
  assert.equal(openapi.includes("canary-value"), false);
  assert.equal(openapi.includes("secret"), false);
});

test("page JSON publishes only public record fields", async () => {
  const files = await pageJson.run(site(), ctx);
  const body = String(files[0]!.contents);
  assert.equal(body.includes("canary-value"), false);
  assert.equal(body.includes("ada@example.test"), false);
  assert.match(body, /"title": "Ada"/);
  assert.match(body, /"name": "Ada"/);
});

test("search documents and facets read the public fields only", () => {
  const searchSite = site({
    collections: {
      people: {
        source: "_data/people.yml",
        template: "_templates/person.md",
        permalink: "/people/{id}/",
        dates: ["date"],
        public: ["title", "author.name"],
        search: { filters: ["title", "secret", "author"], meta: ["secret"] },
      },
    },
  });
  const records = searchableRecords(searchSite);
  assert.deepEqual(records[0]!.fields, { id: "ada", title: "Ada", author: { name: "Ada" } });
  const plan = filterPlan(searchSite, records, () => {});
  assert.deepEqual(Object.keys(plan.fields.find((field) => field.field === "title")!.values), ["Ada"]);
  assert.equal(plan.fields.some((field) => field.field === "secret"), false);
});

test("feeds publish only the public record fields", () => {
  const feedSite = site({
    feeds: { people: { collection: "people", date: "date", fields: ["title", "secret", "author"] } },
  });
  const entries = feedEntries(feedSite, feedSite.config.feeds.people!, "https://example.test");
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0]!.fields, { title: "Ada", author: { name: "Ada" } });
  assert.equal(JSON.stringify(entries).includes("canary-value"), false);
});

test("a change event keeps its identity but not the values of a private field", () => {
  const event = {
    id: "0123456789abcdef",
    type: "changed" as const,
    record: "ada",
    field: "secret",
    old: "canary-old",
    new: "canary-value",
    fields: { title: "Ada", secret: "canary-value" },
    date: "2024-01-02",
  };
  const published = publicChangeEvent(event, ["title"]);
  assert.equal(published.field, "secret");
  assert.equal("old" in published, false);
  assert.equal("new" in published, false);
  assert.deepEqual(published.fields, { title: "Ada" });
  assert.equal(publicChangeEvent(event, undefined), event);
});
