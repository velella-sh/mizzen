import assert from "node:assert/strict";
import { test } from "node:test";
import type { OutputContext, Page, Site } from "../src/contracts/index.ts";
import { robots, robotsText, sitemapUrl } from "../src/outputs/robots.ts";
import { sitemap, writeSitemap, SITEMAP_LIMITS } from "../src/outputs/sitemap.ts";
import { withSite } from "./data-record-site.ts";

const context: OutputContext = { renderPage: async () => "", report: () => {} };

const FILES = {
  "mizzen.yml":
    "url: https://example.com\ncollections:\n  posts:\n    source: _data/posts.yml\n    template: _templates/posts.md\n" +
    "    permalink: /posts/{id}/\n    seo:\n      lastmod: edited\n  notes:\n    source: _data/notes.yml\n    template: _templates/notes.md\n    permalink: /notes/{id}/\n",
  "_data/posts.yml":
    "- id: a\n  title: Alpha\n  edited: 2026-03-04T10:00:00Z\n- id: b\n  title: Beta\n- id: c\n  title: Gamma\n  edited: not a date\n",
  "_data/notes.yml": "- id: n\n  title: Note\n  edited: 2026-01-01\n",
  "_templates/posts.md": '---\ntitle: "{title}"\nupdated: 2020-01-01\n---\n# :field[title]\n',
  "_templates/notes.md": '---\ntitle: "{title}"\n---\n# :field[title]\n',
  "guide.md": "---\ntitle: Guide\nupdated: 2025-05-05\n---\n# Guide\n",
};

const text = async (site: Site, limits = SITEMAP_LIMITS) =>
  Object.fromEntries((await writeSitemap(site, context, limits)).map((file) => [file.path, file.contents.toString()]));

test("lastmod comes from the record field; a record without a valid value has none, even if its template sets updated", async () => {
  await withSite(FILES, async (_root, result) => {
    const files = await text(result.site);
    assert.deepEqual(Object.keys(files), ["sitemap.xml"]);
    const xml = files["sitemap.xml"]!;
    const entry = (url: string): string => new RegExp(`<url>\\s*<loc>https://example.com${url}</loc>[\\s\\S]*?</url>`).exec(xml)![0];
    assert.match(entry("/posts/a/"), /<lastmod>2026-03-04<\/lastmod>/);
    assert.doesNotMatch(entry("/posts/b/"), /lastmod/);
    assert.doesNotMatch(entry("/posts/c/"), /lastmod/);
    assert.doesNotMatch(entry("/notes/n/"), /lastmod/, "a collection without seo.lastmod does not read a field");
    assert.match(entry("/guide/"), /<lastmod>2025-05-05<\/lastmod>/, "ordinary pages keep updated");
  });
});

test("two builds on different dates write identical bytes", async (t) => {
  await withSite(FILES, async (_root, result) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2030-01-01T00:00:00Z") });
    const first = await text(result.site);
    t.mock.timers.reset();
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2041-06-06T00:00:00Z") });
    assert.deepEqual(await text(result.site), first);
    t.mock.timers.reset();
  });
});

test("a small site keeps the single file it always had", async () => {
  await withSite(FILES, async (_root, result) => {
    const files = await sitemap.run(result.site, context);
    assert.deepEqual(files.map((file) => file.path), ["sitemap.xml"]);
    assert.match(files[0]!.contents.toString(), /^<\?xml version="1.0" encoding="UTF-8"\?>\n<urlset /);
  });
});

test("a site over the limit gets an index and one file per collection, and nothing else changes", async () => {
  await withSite(FILES, async (_root, result) => {
    const files = await text(result.site, { urls: 2, bytes: SITEMAP_LIMITS.bytes });
    assert.deepEqual(Object.keys(files), ["sitemap-notes.xml", "sitemap-pages.xml", "sitemap-posts-part-2.xml", "sitemap-posts.xml", "sitemap.xml"]);
    assert.match(files["sitemap.xml"]!, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<sitemapindex /);
    const locs = [...files["sitemap.xml"]!.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    assert.deepEqual(locs, [
      "https://example.com/sitemap-notes.xml",
      "https://example.com/sitemap-pages.xml",
      "https://example.com/sitemap-posts-part-2.xml",
      "https://example.com/sitemap-posts.xml",
    ]);
    assert.match(files["sitemap-posts.xml"]!, /\/posts\/a\/<\/loc>\s*<lastmod>2026-03-04<\/lastmod>[\s\S]*\/posts\/b\//);
    assert.match(files["sitemap-posts-part-2.xml"]!, /\/posts\/c\//);
    assert.match(files["sitemap-notes.xml"]!, /\/notes\/n\//);
    // Every URL appears once across the files.
    const all = Object.entries(files).filter(([path]) => path !== "sitemap.xml").flatMap(([, xml]) => [...xml.matchAll(/<url>\s*<loc>([^<]+)/g)].map((m) => m[1]));
    assert.equal(new Set(all).size, all.length);
    // A byte limit splits too, and the same input gives the same bytes.
    const bytes = await text(result.site, { urls: 50_000, bytes: 400 });
    assert.ok(Object.keys(bytes).length > 2);
    assert.deepEqual(await text(result.site, { urls: 2, bytes: SITEMAP_LIMITS.bytes }), files);
  });
});

function fakePage(url: string, collection?: string): Page {
  return {
    url,
    source: { file: "x.md", line: 1, column: 1, endLine: 1, endColumn: 1 },
    frontMatter: {},
    title: url,
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "",
    markdown: "",
    kind: "doc",
    ...(collection === undefined
      ? {}
      : {
          record: {
            collection,
            id: url,
            position: { file: "d.yml", startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 },
            template: "t.md",
            templateLine: 1,
            fallbacks: [],
          },
        }),
  };
}

test("more than 50,000 URLs write an index at sitemap.xml and files of at most 50,000", async () => {
  const pages = Array.from({ length: 50_001 }, (_, i) => fakePage(`/items/${String(i).padStart(6, "0")}/`, "items"));
  const site = {
    config: { url: "https://example.com", base: "", lang: "en", languages: [], collections: {}, title: "T" },
    pages,
    nav: {},
    data: {},
    collections: {},
  } as unknown as Site;
  const files = await sitemap.run(site, context);
  assert.deepEqual(files.map((file) => file.path), ["sitemap-items-part-2.xml", "sitemap-items.xml", "sitemap.xml"]);
  const count = (path: string): number => (files.find((f) => f.path === path)!.contents.toString().match(/<url>/g) ?? []).length;
  assert.equal(count("sitemap-items.xml"), 50_000);
  assert.equal(count("sitemap-items-part-2.xml"), 1);
  const urls = files.filter((file) => file.path !== "sitemap.xml")
    .flatMap((file) => [...file.contents.toString().matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]!))
    .sort();
  assert.deepEqual(urls, pages.map((page) => `https://example.com${page.url}`));
});

test("robots.txt names sitemap.xml, which is the index when the sitemap is split", async () => {
  await withSite(FILES, async (_root, result) => {
    assert.equal(sitemapUrl(result.site), "https://example.com/sitemap.xml");
    const [file] = await robots.run(result.site, context);
    assert.match(file!.contents.toString(), /\nSitemap: https:\/\/example\.com\/sitemap\.xml\n$/);
    assert.equal(robotsText("https://example.com/sitemap.xml"), "User-agent: *\nAllow: /\n\nSitemap: https://example.com/sitemap.xml\n");
  });
});
