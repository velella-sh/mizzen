import assert from "node:assert/strict";
import { test } from "node:test";
import type { DataRecord, Page, Site, SiteConfig } from "../src/contracts/index.ts";
import type { OutputContext } from "../src/contracts/output.ts";
import { recordCalendar, recordCalendarUrl, recordPropsWithCalendar } from "../src/outputs/record-calendar.ts";
import { recordPropsOf } from "../src/data/record-context.ts";

const pos = { file: "_data/runtimes.yml", startLine: 3, startColumn: 1, endLine: 7, endColumn: 1 };

function config(overrides: Partial<SiteConfig> = {}): SiteConfig {
  return {
    title: "Example", url: "https://docs.example.com", base: "/docs", lang: "en", dir: "ltr", languages: [], source: ".", include: [], exclude: [],
    navigation: "_data/navigation.yml",
    collections: { runtimes: { source: "_data/runtimes.yml", dates: ["eol", "securityEnd"] }, tools: { source: "_data/tools.yml" } },
    feeds: {},
    calendars: { eol: { collection: "runtimes", events: [{ name: "eol", field: "eol", title: "{title} ends" }, { name: "security", field: "securityEnd" }] } },
    defaults: [], theme: { options: {} }, search: {}, redirects: {}, outputs: {},
    ...overrides,
  };
}

function record(id: string, fields: Record<string, unknown>): DataRecord {
  const dates: Record<string, string> = {};
  for (const key of ["eol", "securityEnd"]) if (typeof fields[key] === "string") dates[key] = fields[key] as string;
  return { id, fields, position: pos, fieldPositions: {}, normalizedDates: dates };
}

function page(collection: string, id: string): Page {
  return {
    url: `/docs/${collection}/${id}/`,
    source: { file: "t.md", line: 1, column: 1, endLine: 1, endColumn: 1 },
    frontMatter: {}, title: id, lang: "en", dir: "ltr", headings: [], html: "", markdown: "", kind: "doc",
    record: { collection, id, position: pos, template: "t.md", templateLine: 1, fallbacks: [] },
  };
}

const runtimes = [
  record("node-20", { title: "Node 20", eol: "2026-04-30", securityEnd: "2026-10-01", updated: "2026-03-01" }),
  record("bare", { title: "Bare", updated: "2026-03-01" }),
];
const tools = [record("tsc", { title: "tsc", eol: "2026-01-01", updated: "2026-03-01" })];

function site(): Site {
  return {
    config: config(),
    pages: [...runtimes.map((r) => page("runtimes", r.id)), page("tools", "tsc")],
    nav: {},
    collections: {
      runtimes: { name: "runtimes", source: "_data/runtimes.yml", records: runtimes },
      tools: { name: "tools", source: "_data/tools.yml", records: tools },
    },
    data: {},
  };
}

const ctx: OutputContext = { renderPage: () => Promise.reject(new Error("no page")), report: () => {} };

test("a record with two events gets one file beside its page with both events", async () => {
  const files = await recordCalendar.run(site(), ctx);
  assert.deepEqual(files.map((f) => f.path), ["runtimes/node-20/calendar.ics"]);
  const text = files[0]!.contents as string;
  assert.equal(text.match(/BEGIN:VEVENT/g)?.length, 2);
  assert.match(text, /SUMMARY:Node 20 ends/);
  assert.match(text, /X-WR-CALNAME:Node 20/);
});

test("a record with no events has no file and no address; nor does a collection without a calendar", () => {
  const s = site();
  assert.equal(recordCalendarUrl(s, s.pages.find((p) => p.record?.id === "bare")!), undefined);
  assert.equal(recordCalendarUrl(s, s.pages.find((p) => p.record?.collection === "tools")!), undefined);
});

test("the address reaches the theme in the record props, with base", () => {
  const s = site();
  const p = s.pages.find((x) => x.record?.id === "node-20")!;
  assert.equal(recordCalendarUrl(s, p), "/docs/runtimes/node-20/calendar.ics");
  assert.equal(recordPropsWithCalendar(s, p)?.calendar, "/docs/runtimes/node-20/calendar.ics");
  assert.equal(recordPropsOf(s, p)?.calendar, undefined);
  assert.equal("calendar" in recordPropsWithCalendar(s, s.pages.find((x) => x.record?.collection === "tools")!)!, false);
});

test("switching the output off removes the address", async () => {
  const s = site();
  const off = { ...s, config: { ...s.config, outputs: { "record-calendar": false } } } as Site;
  assert.equal(recordCalendarUrl(off, off.pages[0]!), undefined);
  assert.deepEqual(await recordCalendar.run(off, ctx), []);
});
