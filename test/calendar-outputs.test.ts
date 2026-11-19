import assert from "node:assert/strict";
import { test } from "node:test";
import type { DataRecord, Page, Site, SiteConfig } from "../src/contracts/index.ts";
import type { Diagnostic } from "../src/contracts/diagnostic.ts";
import type { OutputContext } from "../src/contracts/output.ts";
import { calendars } from "../src/outputs/calendars.ts";
import { listCalendarsOf } from "../src/calendar/links.ts";

const pos = { file: "_data/runtimes.yml", startLine: 3, startColumn: 1, endLine: 7, endColumn: 1 };

function config(overrides: Partial<SiteConfig> = {}): SiteConfig {
  return {
    title: "Example",
    url: "https://docs.example.com",
    base: "",
    lang: "en",
    dir: "ltr",
    languages: [],
    source: ".",
    include: [],
    exclude: [],
    navigation: "_data/navigation.yml",
    collections: { runtimes: { source: "_data/runtimes.yml", dates: ["eol", "securityEnd"] } },
    feeds: {},
    calendars: {
      eol: {
        collection: "runtimes",
        events: [{ name: "eol", field: "eol", title: "{title} ends" }, { name: "security", field: "securityEnd" }],
        reminders: ["7d"],
      },
    },
    defaults: [],
    theme: { options: {} },
    search: {},
    redirects: {},
    outputs: {},
    ...overrides,
  };
}

function record(id: string, fields: Record<string, unknown>): DataRecord {
  const dates: Record<string, string> = {};
  for (const key of ["eol", "securityEnd"]) if (typeof fields[key] === "string") dates[key] = fields[key] as string;
  return { id, fields, position: pos, fieldPositions: {}, normalizedDates: dates };
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
  record("node-20", { title: "Node 20", vendor: "OpenJS", eol: "2026-04-30", securityEnd: "2026-10-01", updated: "2026-03-01" }),
  record("node-22", { title: "Node 22", vendor: "OpenJS", eol: "2027-04-30", updated: "2026-03-02" }),
  record("py-3", { title: "Python 3", vendor: "PSF", eol: "2028-10-01", updated: "2026-03-03" }),
];

function site(overrides: Partial<SiteConfig> = {}, recs: readonly DataRecord[] = records, asOf?: string): Site {
  const cfg = config(overrides);
  return {
    config: asOf === undefined ? cfg : { ...cfg, collections: { runtimes: { ...cfg.collections["runtimes"]!, referenceDate: asOf } } },
    pages: recs.map((r) => page(r.id)),
    nav: {},
    collections: { runtimes: { name: "runtimes", source: "_data/runtimes.yml", records: recs } },
    data: {},
  };
}

function context(): { ctx: OutputContext; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  return { diagnostics, ctx: { renderPage: () => Promise.reject(new Error("no page")), report: (d) => diagnostics.push(d) } };
}

test("a calendar without groupBy writes one file with every event, in date order", async () => {
  const { ctx, diagnostics } = context();
  const files = await calendars.run(site(), ctx);
  assert.deepEqual(files.map((f) => f.path), ["calendars/eol.ics"]);
  const text = files[0]!.contents as string;
  assert.equal(text.match(/BEGIN:VEVENT/g)?.length, 4);
  assert.ok(text.indexOf("Node 20 ends") < text.indexOf("Node 22 ends"));
  assert.match(text, /UID:runtimes\/node-20\/eol@docs.example.com/);
  assert.match(text, /DTSTAMP:20260301T000000Z/);
  assert.match(text, /URL:https:\/\/docs.example.com\/runtimes\/node-20\//);
  assert.match(text, /TRIGGER:-P7D/);
  assert.deepEqual(diagnostics.map((d) => d.id), ["calendars.skipped"]);
});

test("groupBy adds one file per group value", async () => {
  const { ctx } = context();
  const base = config().calendars!["eol"]!;
  const files = await calendars.run(site({ calendars: { eol: { ...base, groupBy: "vendor" } } }), ctx);
  assert.deepEqual(files.map((f) => f.path), ["calendars/eol.ics", "calendars/eol/openjs.ics", "calendars/eol/psf.ics"]);
  assert.equal((files[1]!.contents as string).match(/BEGIN:VEVENT/g)?.length, 3);
  assert.equal((files[2]!.contents as string).match(/BEGIN:VEVENT/g)?.length, 1);
});

test("list subscriptions name only published collection and matching group calendars", async () => {
  const eol = { ...config().calendars!["eol"]!, groupBy: "vendor" };
  const empty = { ...eol, where: { vendor: "Nobody" } };
  const overrides = { base: "/docs", calendars: { eol, empty } };
  const s = site(overrides, [
    ...records,
    record("collision", { vendor: "openjs", eol: "2026-04-30", updated: "2026-03-01" }),
  ]);
  const list = {
    collection: "runtimes",
    records: [],
    groups: ["OpenJS", "PSF", "openjs", "Nobody"].map((key) => ({ key, records: [] })),
    pagination: { page: 1, total: 1 },
  };
  const p: Page = { ...page("list"), list, frontMatter: { list: { group: "vendor" } } };
  const subscriptions = listCalendarsOf(s, p)!;
  assert.deepEqual(subscriptions.calendars?.map((c) => c.webcal), ["webcal://docs.example.com/docs/calendars/eol.ics"]);
  assert.deepEqual(subscriptions.groups.map((g) => g.calendars?.[0]?.url), [
    "https://docs.example.com/docs/calendars/eol/openjs.ics",
    "https://docs.example.com/docs/calendars/eol/psf.ics",
    undefined,
    undefined,
  ]);
  const written = (await calendars.run(s, context().ctx)).map((f) => f.path);
  for (const c of [...subscriptions.calendars!, ...subscriptions.groups.flatMap((g) => g.calendars ?? [])]) {
    assert.ok(written.includes(new URL(c.url).pathname.slice("/docs/".length)));
  }
  assert.ok(listCalendarsOf(s, { ...p, frontMatter: { list: { group: "other" } } })?.groups.every((g) => g.calendars === undefined));
  const expanded = { ...list, groups: [{ ...list.groups[0]!, url: "/docs/vendor/openjs/" }] };
  assert.equal(listCalendarsOf(s, { ...p, list: expanded, frontMatter: { list: { expand: { field: "vendor" } } } })
    ?.groups[0]?.calendars?.[0]?.url, subscriptions.groups[0]?.calendars?.[0]?.url);
  assert.equal(listCalendarsOf(site({ ...overrides, outputs: { calendars: false } }), p), list);
  assert.equal(listCalendarsOf(site({ ...overrides, url: "not a URL" }), p), list);
});

test("an empty calendar writes no file and is reported", async () => {
  const { ctx, diagnostics } = context();
  const base = config().calendars!["eol"]!;
  const files = await calendars.run(site({ calendars: { eol: { ...base, where: { vendor: "nobody" } } } }), ctx);
  assert.deepEqual(files, []);
  assert.deepEqual(diagnostics.map((d) => d.id), ["calendars.empty"]);
});

test("a record with no stamp source is reported and left out, never stamped from the clock", async () => {
  const { ctx, diagnostics } = context();
  const bare = [record("a", { title: "A", eol: "2026-04-30" })];
  assert.deepEqual(await calendars.run(site({}, bare), ctx), []);
  assert.ok(diagnostics.some((d) => d.id === "calendars.no-stamp"));
  const again = context();
  const files = await calendars.run(site({}, bare, "2026-01-01"), again.ctx);
  assert.match(files[0]!.contents as string, /DTSTAMP:20260101T000000Z/);
});

test("the limit cuts every file, and builds are byte-identical", async () => {
  const base = config().calendars!["eol"]!;
  const cfg = { calendars: { eol: { ...base, limit: 2 } } };
  const first = await calendars.run(site(cfg), context().ctx);
  const second = await calendars.run(site(cfg), context().ctx);
  assert.equal((first[0]!.contents as string).match(/BEGIN:VEVENT/g)?.length, 2);
  assert.deepEqual(first, second);
});

test("a site with no calendars writes nothing, and one without a url reports it", async () => {
  assert.deepEqual(await calendars.run(site({ calendars: {} }), context().ctx), []);
  const { ctx, diagnostics } = context();
  const noUrl = site();
  assert.deepEqual(await calendars.run({ ...noUrl, config: { ...noUrl.config, url: "" } }, ctx), []);
  assert.deepEqual(diagnostics.map((d) => d.id), ["calendars.no-url"]);
});
