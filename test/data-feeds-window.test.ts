import assert from "node:assert/strict";
import { test } from "node:test";
import type { CalendarConfig, DataRecord, Page, Site, SiteConfig } from "../src/contracts/index.ts";
import type { Diagnostic } from "../src/contracts/diagnostic.ts";
import type { OutputContext, OutputFile } from "../src/contracts/output.ts";
import { feeds } from "../src/outputs/feeds.ts";

const pos = { file: "_data/runtimes.yml", startLine: 3, startColumn: 1, endLine: 7, endColumn: 1 };

const calendar: CalendarConfig = {
  collection: "runtimes",
  events: [{ name: "eol", field: "eol", title: "{title} ends" }],
};

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
    collections: { runtimes: { source: "_data/runtimes.yml", dates: ["eol"] } },
    feeds: {},
    calendars: { eol: calendar },
    defaults: [],
    theme: { options: {} },
    search: {},
    redirects: {},
    outputs: {},
    ...overrides,
  };
}

function record(id: string, eol: string): DataRecord {
  return { id, fields: { title: id.toUpperCase(), eol }, position: pos, fieldPositions: {}, normalizedDates: { eol } };
}

function page(id: string): Page {
  return {
    url: `/runtimes/${id}/`,
    source: { file: "_templates/runtime.md", line: 1, column: 1, endLine: 1, endColumn: 1 },
    frontMatter: {},
    title: id,
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "",
    markdown: "",
    kind: "doc",
    record: { collection: "runtimes", id, position: pos, template: "_templates/runtime.md", templateLine: 1, fallbacks: [] },
  };
}

const records = [
  record("past", "2025-12-31"),
  record("first", "2026-01-01"),
  record("last", "2026-01-31"),
  record("later", "2026-02-01"),
];

function site(overrides: Partial<SiteConfig> = {}, asOf?: string): Site {
  const cfg = config(overrides);
  return {
    config: asOf === undefined ? cfg : { ...cfg, asOf },
    pages: records.map((r) => page(r.id)),
    nav: {},
    collections: { runtimes: { name: "runtimes", source: "_data/runtimes.yml", records } },
    data: {},
  };
}

function windowed(): Site {
  return site({
    feeds: {
      "ending-soon": { collection: "runtimes", date: "eol", formats: ["atom", "json"], window: { days: 30 } },
    },
  }, "2026-01-01");
}

function context(): { ctx: OutputContext; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  return { diagnostics, ctx: { renderPage: () => Promise.reject(new Error("feeds render no page")), report: (d) => diagnostics.push(d) } };
}

async function run(model: Site): Promise<{ files: readonly OutputFile[]; diagnostics: readonly Diagnostic[] }> {
  const { ctx, diagnostics } = context();
  return { files: await feeds.run(model, ctx), diagnostics };
}

function entryIds(file: OutputFile): string[] {
  const text = String(file.contents);
  const ids = file.path.endsWith(".json")
    ? [...text.matchAll(/"id": "([^"]*)"/g)].map((match) => match[1]!)
    : [...text.matchAll(/<id>([^<]*)<\/id>/g)].map((match) => match[1]!);
  return ids.filter((id) => id !== "tag:example.test:feeds/ending-soon");
}

test("a window keeps entries from the as-of date to the as-of date plus days, both included", async () => {
  const { files, diagnostics } = await run(windowed());
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(files.map((file) => file.path), ["feeds/ending-soon.json", "feeds/ending-soon.xml"]);

  const xml = String(files[1]!.contents);
  assert.ok(xml.includes(">FIRST<") && xml.includes(">LAST<"), "the first and last day of the window are in it");
  assert.ok(!xml.includes(">PAST<") && !xml.includes(">LATER<"), "the days outside the window are not");

  const json = JSON.parse(String(files[0]!.contents)) as { items: Array<{ id: string }> };
  assert.deepEqual(json.items.map((item) => item.id), entryIds(files[0]!));
});

test("a windowed entry id is the calendar event's id", async () => {
  const { files } = await run(windowed());
  assert.deepEqual(entryIds(files[0]!), [
    "runtimes/last/eol@example.test",
    "runtimes/first/eol@example.test",
  ]);
});

test("without a calendar event the entry keeps the feed's tag id", async () => {
  const model = site(
    {
      calendars: {},
      feeds: { "ending-soon": { collection: "runtimes", date: "eol", window: { days: 30 } } },
    },
    "2026-01-01",
  );
  const { files } = await run(model);
  assert.deepEqual(entryIds(files[0]!), ["tag:example.test:runtimes/last", "tag:example.test:runtimes/first"]);
});

test("two as-of dates give two windows over the same data", async () => {
  const january = await run(windowed());
  const february = await run(site({ feeds: windowed().config.feeds }, "2026-02-01"));
  assert.deepEqual(entryIds(january.files[0]!), ["runtimes/last/eol@example.test", "runtimes/first/eol@example.test"]);
  assert.deepEqual(entryIds(february.files[0]!), ["runtimes/later/eol@example.test"]);
});

test("one as-of date writes identical bytes on every run", async () => {
  const first = await run(windowed());
  const second = await run(windowed());
  assert.deepEqual(first.files, second.files);
});

test("the collection's reference date starts the window when the site sets no asOf", async () => {
  const model = site({
    collections: { runtimes: { source: "_data/runtimes.yml", dates: ["eol"], referenceDate: "2026-01-01" } },
    feeds: { "ending-soon": { collection: "runtimes", date: "eol", window: { days: 30 } } },
  });
  assert.deepEqual(entryIds((await run(model)).files[0]!), [
    "runtimes/last/eol@example.test",
    "runtimes/first/eol@example.test",
  ]);
});

test("a window with no as-of date reports it and writes no file, never reading the clock", async () => {
  const model = site({ feeds: { "ending-soon": { collection: "runtimes", date: "eol", window: { days: 30 } } } });
  const { files, diagnostics } = await run(model);
  assert.deepEqual(files, []);
  assert.deepEqual(
    diagnostics.map((d) => [d.id, d.severity]),
    [["dates.no-as-of", "error"]],
  );
  assert.match(diagnostics[0]!.help ?? "", /--as-of/);
});
