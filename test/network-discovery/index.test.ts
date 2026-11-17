/** `mizzen network sitemap` covers absolute and nested paths, duplicates, a hidden project, the root's own map, and never lists the index itself. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runNetwork } from "../../src/cli/network.ts";
import { sitemapIndexText } from "../../src/network/sitemap.ts";
import { networkSite } from "../helpers-network.ts";

const ORIGIN = "https://example.org";
const ROOT_MAP = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  "  <url>",
  "    <loc>https://example.org/</loc>",
  "  </url>",
  "</urlset>",
  "",
].join("\n");

const locs = (xml: string): string[] => [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((match) => match[1]!);

/** Runs `network sitemap` for `root` into `out`, keeping its streams. */
async function run(root: string, out: string, origin = ORIGIN): Promise<{ code: number; errors: string }> {
  const lines: string[] = [];
  const errors: string[] = [];
  const code = await runNetwork(["sitemap", root, "--url", origin, "--out", out], { log: (line) => lines.push(line), error: (line) => errors.push(line) });
  return { code, errors: errors.join("\n") };
}

test("nested and absolute paths each become one absolute URL", () => {
  const xml = sitemapIndexText(ORIGIN, [
    { path: "/docs", public: true },
    { path: "blog/notes/", public: true },
  ]);
  assert.deepEqual(locs(xml), ["https://example.org/blog/notes/sitemap.xml", "https://example.org/docs/sitemap.xml"]);
});

test("the same address written two ways is listed once", () => {
  const xml = sitemapIndexText(ORIGIN, [
    { path: "docs", public: true },
    { path: "/docs/", public: true },
  ]);
  assert.deepEqual(locs(xml), ["https://example.org/docs/sitemap.xml"]);
});

test("a project that is not public is left out", () => {
  const xml = sitemapIndexText(ORIGIN, [
    { path: "docs", public: true },
    { path: "internal", public: false },
  ]);
  assert.deepEqual(locs(xml), ["https://example.org/docs/sitemap.xml"]);
});

test("the index never lists itself", () => {
  assert.deepEqual(locs(sitemapIndexText(ORIGIN, [{ path: "/", public: true }])), []);
});

test("the root site's own sitemap is listed and kept as sitemap-pages.xml", async () => {
  const root = await networkSite();
  const out = mkdtempSync(join(tmpdir(), "mizzen-netmap-"));
  writeFileSync(join(out, "sitemap.xml"), ROOT_MAP);
  const result = await run(root, out);
  assert.equal(result.code, 0, result.errors);
  assert.equal(readFileSync(join(out, "sitemap-pages.xml"), "utf8"), ROOT_MAP);
  assert.deepEqual(locs(readFileSync(join(out, "sitemap.xml"), "utf8")), [
    "https://example.org/blog/sitemap.xml",
    "https://example.org/docs/sitemap.xml",
    "https://example.org/sitemap-pages.xml",
  ]);
});

test("a split root sitemap keeps its child files in the index, and a second run writes the same bytes", async () => {
  const root = await networkSite();
  const out = mkdtempSync(join(tmpdir(), "mizzen-netmap-"));
  const rootIndex = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    "  <sitemap>",
    "    <loc>https://example.org/sitemap-pages.xml</loc>",
    "  </sitemap>",
    "  <sitemap>",
    "    <loc>https://example.org/sitemap-guide.xml</loc>",
    "  </sitemap>",
    "</sitemapindex>",
    "",
  ].join("\n");
  writeFileSync(join(out, "sitemap.xml"), rootIndex);
  assert.equal((await run(root, out)).code, 0);
  const first = readFileSync(join(out, "sitemap.xml"), "utf8");
  assert.deepEqual(locs(first), [
    "https://example.org/blog/sitemap.xml",
    "https://example.org/docs/sitemap.xml",
    "https://example.org/sitemap-guide.xml",
    "https://example.org/sitemap-pages.xml",
  ]);
  assert.equal((await run(root, out)).code, 0);
  assert.equal(readFileSync(join(out, "sitemap.xml"), "utf8"), first);
});

test("the index is a well-formed sitemap index with absolute, unique URLs", async () => {
  const root = await networkSite();
  const out = mkdtempSync(join(tmpdir(), "mizzen-netmap-"));
  writeFileSync(join(out, "sitemap.xml"), ROOT_MAP);
  assert.equal((await run(root, out)).code, 0);
  const xml = readFileSync(join(out, "sitemap.xml"), "utf8");
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<sitemapindex xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">\n(?:  <sitemap>\n    <loc>https:\/\/example\.org\/[^<]+<\/loc>\n  <\/sitemap>\n)+<\/sitemapindex>\n$/);
  const listed = locs(xml);
  assert.equal(new Set(listed).size, listed.length);
  for (const loc of listed) assert.equal(new URL(loc).origin, ORIGIN);
});
