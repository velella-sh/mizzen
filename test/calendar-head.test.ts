import assert from "node:assert/strict";
import { test } from "node:test";
import type { DataRecord, Page, Site, SiteConfig } from "../src/contracts/index.ts";
import { headMeta } from "../src/outputs/head-meta.ts";
import { llms } from "../src/outputs/llms.ts";
import { recordPropsWithCalendar } from "../src/outputs/record-calendar.ts";

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


const ctx = { renderPage: () => Promise.reject(new Error("no page")), report: () => {} };
const alternates = (s: Site, p: Page) => headMeta(s, p, []).links.filter((l) => l.attrs?.["type"] === "text/calendar");

test("a record page in a calendar links it in the head, with the https address", () => {
  const s = site();
  const p = s.pages.find((x) => x.record?.id === "node-20")!;
  assert.deepEqual(alternates(s, p), [
    { rel: "alternate", href: "https://docs.example.com/docs/calendars/eol.ics", attrs: { type: "text/calendar", title: "Example: eol" } },
  ]);
});

test("a page that is not in a calendar links none", () => {
  const s = site();
  assert.deepEqual(alternates(s, s.pages.find((x) => x.record?.id === "bare")!), []);
  assert.deepEqual(alternates(s, s.pages.find((x) => x.record?.collection === "tools")!), []);
  assert.deepEqual(alternates(s, { ...s.pages[0]!, record: undefined } as unknown as Page), []);
});

test("the props carry the https and webcal addresses", () => {
  const s = site();
  const props = recordPropsWithCalendar(s, s.pages.find((x) => x.record?.id === "node-20")!);
  assert.deepEqual(props?.calendars, [
    { name: "eol", title: "Example: eol", url: "https://docs.example.com/docs/calendars/eol.ics", webcal: "webcal://docs.example.com/docs/calendars/eol.ics" },
  ]);
  assert.equal(recordPropsWithCalendar(s, s.pages.find((x) => x.record?.id === "bare")!)?.calendars, undefined);
});

test("llms.txt lists each written calendar, and an empty or switched-off one is not listed", async () => {
  const s = site();
  const text = async (x: Site) => (await llms.run(x, ctx))[0]!.contents as string;
  assert.match(await text(s), /## Calendars\n\n- \[eol\]\(https:\/\/docs.example.com\/docs\/calendars\/eol.ics\): 2 events\n/);
  const off = { ...s, config: { ...s.config, outputs: { calendars: false } } } as Site;
  assert.doesNotMatch(await text(off), /Calendars/);
  const empty = { ...s, config: { ...s.config, calendars: { eol: { ...s.config.calendars!["eol"]!, where: { vendor: "x" } } } } } as Site;
  assert.doesNotMatch(await text(empty), /Calendars/);
});
