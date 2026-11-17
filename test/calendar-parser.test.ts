import assert from "node:assert/strict";
import { test } from "node:test";
import type { DataRecord, Page, Site, SiteConfig } from "../src/contracts/index.ts";
import type { OutputContext, OutputFile } from "../src/contracts/output.ts";
import ICAL from "ical.js";
import { calendars } from "../src/outputs/calendars.ts";
import { recordCalendar } from "../src/outputs/record-calendar.ts";

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
  record("node-20", { title: "Node 20", vendor: "OpenJS", eol: "2026-04-30", securityEnd: "2026-10-01", updated: "2026-03-01" }),
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

/** Every calendar file one build writes, sorted by path. */
async function build(): Promise<readonly OutputFile[]> {
  const s = site();
  const withGroups = {
    ...s,
    config: { ...s.config, calendars: { eol: { ...s.config.calendars!["eol"]!, reminders: ["30d", "7d"], groupBy: "vendor" } } },
  } as Site;
  return [...(await calendars.run(withGroups, ctx)), ...(await recordCalendar.run(withGroups, ctx))].sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** Throws when two builds differ in a path or a byte, naming the first difference. */
function assertSameBuild(a: readonly OutputFile[], b: readonly OutputFile[]): void {
  assert.deepEqual(a.map((f) => f.path), b.map((f) => f.path));
  a.forEach((file, i) => assert.equal(file.contents, b[i]!.contents, `${file.path} differs`));
}

test("an independent parser reads every generated file, and each event has an id, a date, and a summary", async () => {
  const files = await build();
  assert.ok(files.some((f) => f.path.startsWith("calendars/eol/")), "a group file");
  for (const file of files) {
    const root = new ICAL.Component(ICAL.parse(file.contents as string));
    assert.equal(root.name, "vcalendar", file.path);
    const events = root.getAllSubcomponents("vevent");
    assert.ok(events.length > 0, file.path);
    for (const vevent of events) {
      const event = new ICAL.Event(vevent);
      assert.match(event.uid, /^runtimes\/[^/]+\/[a-z]+@docs\.example\.com$/, file.path);
      assert.ok(event.startDate.isDate, `${file.path}: an all-day date`);
      assert.match(event.startDate.toString(), /^\d{4}-\d{2}-\d{2}$/);
      assert.notEqual(event.summary, "", file.path);
    }
  }
});

test("the parser reads the Persian title, the reminders, and the multi-day end back", async () => {
  const s = site();
  const odd = {
    ...s,
    collections: {
      ...s.collections,
      runtimes: {
        ...s.collections["runtimes"]!,
        records: [record("fa", { title: "پایان پشتیبانی نسخهٔ بیست و دو، با متنی که از هفتاد و پنج بایت بلندتر است", eol: "2026-04-30", securityEnd: "2026-05-02", updated: "2026-03-01" })],
      },
    },
    pages: [page("runtimes", "fa")],
    config: {
      ...s.config,
      calendars: { eol: { collection: "runtimes", events: [{ name: "eol", field: "eol", end: "securityEnd", title: "{title}" }], reminders: ["30d", "7d"] } },
    },
  } as Site;
  const [file] = await calendars.run(odd, ctx);
  const vevent = new ICAL.Component(ICAL.parse(file!.contents as string)).getFirstSubcomponent("vevent")!;
  const event = new ICAL.Event(vevent);
  assert.equal(event.summary, "پایان پشتیبانی نسخهٔ بیست و دو، با متنی که از هفتاد و پنج بایت بلندتر است");
  assert.equal(event.endDate.toString(), "2026-05-03");
  assert.deepEqual(vevent.getAllSubcomponents("valarm").map((a) => a.getFirstPropertyValue("trigger")?.toString()), ["-P30D", "-P7D"]);
});

test("two builds are byte-identical, and a UID that changes between builds is caught", async () => {
  const first = await build();
  assertSameBuild(first, await build());
  const changed = first.map((f) => ({ ...f, contents: (f.contents as string).replace("UID:runtimes/node-20/eol@", "UID:runtimes/node-20/end@") }));
  assert.throws(() => assertSameBuild(first, changed), /differs/);
});
