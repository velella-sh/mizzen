/**
 * Example status in page JSON (#1336). A page with recorded evidence carries an `examples` object keyed by fence id,
 * with the state, provenance, and a summary of what each run checked.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page, Site, SiteConfig } from "../src/contracts/index.ts";
import type { FenceExampleResult } from "../src/contracts/code.ts";
import { pageJson } from "../src/outputs/page-json.ts";

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
    collections: {},
    feeds: {},
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
    source: { file: "guide.md", line: 1, column: 1, endLine: 1, endColumn: 1 },
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

function site(pages: readonly Page[]): Site {
  return { config: config(), pages, nav: {}, collections: {}, data: {} };
}

async function jsonOf(model: Site): Promise<Record<string, unknown>> {
  const files = await pageJson.run(model, { renderPage: async () => "", report: () => {} });
  return JSON.parse(String(files[0]?.contents)) as Record<string, unknown>;
}

const PASSED: FenceExampleResult = {
  status: "passed",
  file: "guide.md",
  line: 3,
  language: "js",
  date: "2026-11-23",
  commit: "a".repeat(40),
  sha256: "b".repeat(64),
  exitCode: 0,
  environment: "c".repeat(64),
  evidence: {
    exitCode: 0,
    outputs: [
      { stream: "stdout", match: "exact", expected: "hi", actual: "hi", ok: true },
    ],
  },
};

test("a page with no recorded examples has no examples key", async () => {
  const json = await jsonOf(site([page("/a/")]));
  assert.equal("examples" in json, false);
});

test("a recorded example appears with its status, provenance, and output summary", async () => {
  const json = await jsonOf(site([page("/a/", { examples: { "example-1": PASSED } })]));
  assert.deepEqual(json.examples, {
    "example-1": {
      status: "passed",
      file: "guide.md",
      line: 3,
      language: "js",
      date: "2026-11-23",
      commit: "a".repeat(40),
      sha256: "b".repeat(64),
      exitCode: 0,
      environment: "c".repeat(64),
      outputs: [{ stream: "stdout", ok: true }],
    },
  });
});

test("a stale result keeps its recorded status instead of a current one", async () => {
  const stale: FenceExampleResult = {
    status: "stale",
    recordedStatus: "passed",
    file: "guide.md",
    line: 3,
    language: "js",
    date: "2026-11-23",
    commit: "a".repeat(40),
    sha256: "b".repeat(64),
  };
  const json = await jsonOf(site([page("/a/", { examples: { "example-1": stale } })]));
  const entry = (json.examples as Record<string, Record<string, unknown>>)["example-1"]!;
  assert.equal(entry.status, "stale");
  assert.equal(entry.recordedStatus, "passed");
  assert.equal("date" in entry, false, "a stale result carries no current provenance");
});

test("two runs produce the same bytes and the keys are sorted", async () => {
  const model = site([
    page("/b/", { examples: { "example-2": PASSED, "example-1": PASSED } }),
    page("/a/"),
  ]);
  const first = await pageJson.run(model, { renderPage: async () => "", report: () => {} });
  const second = await pageJson.run(model, { renderPage: async () => "", report: () => {} });
  // Files are sorted by path, so `b/index.json` is second.
  const bFirst = JSON.parse(String(first.find((file) => file.path.startsWith("b/"))?.contents)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(bFirst.examples as object), ["example-1", "example-2"]);
  assert.deepEqual(first.map((file) => String(file.contents)), second.map((file) => String(file.contents)));
});
