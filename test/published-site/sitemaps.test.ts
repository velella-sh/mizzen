/** `mizzen published-site check`: sitemap and index reading, duplicates, cycles, foreign hosts, and the limits. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import {
  SITEMAP_MAX_BYTES,
  SITEMAP_MAX_DEPTH,
  SITEMAP_MAX_FILES,
  SITEMAP_MAX_LOCS,
  SITEMAP_MAX_URLS,
  enumerateSitemaps,
  type SitemapFetchLike,
} from "../../src/published-site/sitemaps.ts";

const HEAD = '<?xml version="1.0" encoding="UTF-8"?>';

function urlset(...locs: string[]): string {
  return `${HEAD}\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${locs.map((loc) => `  <url><loc>${loc}</loc></url>\n`).join("")}</urlset>\n`;
}

function index(...locs: string[]): string {
  return `${HEAD}\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${locs.map((loc) => `  <sitemap><loc>${loc}</loc></sitemap>\n`).join("")}</sitemapindex>\n`;
}

/** A fetch that serves `files` by exact URL; a number serves that status and a missing URL serves 404. */
function server(files: Record<string, string | Uint8Array | number>): { requested: string[]; fetch: SitemapFetchLike } {
  const requested: string[] = [];
  const fetch: SitemapFetchLike = async (url) => {
    requested.push(url);
    const file = files[url];
    if (file === undefined) return new Response("not found", { status: 404 });
    if (typeof file === "number") return new Response(null, { status: file });
    return new Response(file as BodyInit);
  };
  return { requested, fetch };
}

test("a valid index resolves to the page URLs of its sitemaps, in sitemap order", async () => {
  const site = server({
    "https://example.test/sitemap.xml": index("https://example.test/pages.xml", "https://example.test/guides.xml"),
    "https://example.test/pages.xml": urlset("https://example.test/", "https://example.test/about/"),
    "https://example.test/guides.xml": urlset("https://example.test/guide/"),
  });
  const result = await enumerateSitemaps({ sitemap: "https://example.test/sitemap.xml", fetch: site.fetch });
  assert.deepEqual(result.urls, [
    "https://example.test/",
    "https://example.test/about/",
    "https://example.test/guide/",
  ]);
  assert.deepEqual(result.findings, []);
});

test("a standalone urlset yields its page URLs", async () => {
  const site = server({ "https://example.test/sitemap.xml": urlset("https://example.test/", "https://example.test/?a=1&amp;b=2") });
  const result = await enumerateSitemaps({ sitemap: "https://example.test/sitemap.xml", fetch: site.fetch });
  assert.deepEqual(result.urls, ["https://example.test/", "https://example.test/?a=1&b=2"]);
});

test("a repeated page URL is reported once and returned once", async () => {
  const site = server({
    "https://example.test/sitemap.xml": index("https://example.test/a.xml", "https://example.test/b.xml"),
    "https://example.test/a.xml": urlset("https://example.test/guide/", "https://example.test/guide/"),
    "https://example.test/b.xml": urlset("https://example.test/guide/"),
  });
  const result = await enumerateSitemaps({ sitemap: "https://example.test/sitemap.xml", fetch: site.fetch });
  assert.deepEqual(result.urls, ["https://example.test/guide/"]);
  const duplicates = result.findings.filter((finding) => finding.id === "published-site.sitemap-duplicate");
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0]!.severity, "warning");
});

test("an index that reaches itself is a cycle, not a loop", async () => {
  const site = server({
    "https://example.test/sitemap.xml": index("https://example.test/sitemap.xml", "https://example.test/pages.xml"),
    "https://example.test/pages.xml": urlset("https://example.test/"),
  });
  const result = await enumerateSitemaps({ sitemap: "https://example.test/sitemap.xml", fetch: site.fetch });
  assert.deepEqual(result.urls, ["https://example.test/"]);
  assert.deepEqual(result.findings.map((finding) => finding.id), ["published-site.sitemap-cycle"]);
});

test("an address on another host is a domain finding and is never requested", async () => {
  const site = server({
    "https://example.test/sitemap.xml": index("https://other.test/map.xml", "https://example.test/pages.xml"),
    "https://example.test/pages.xml": urlset("https://example.test/", "https://other.test/page/"),
  });
  const result = await enumerateSitemaps({ sitemap: "https://example.test/sitemap.xml", fetch: site.fetch });
  assert.deepEqual(result.urls, ["https://example.test/"]);
  assert.deepEqual(site.requested, ["https://example.test/sitemap.xml", "https://example.test/pages.xml"]);
  assert.deepEqual(result.findings.map((finding) => finding.id), ["published-site.domain", "published-site.domain"]);
});

test("the sitemap entry point may be on another host", async () => {
  const site = server({
    "https://cdn.example/feed.xml": urlset("https://example.test/"),
  });
  const result = await enumerateSitemaps({ sitemap: "https://cdn.example/feed.xml", domain: "example.test", fetch: site.fetch });
  assert.deepEqual(result.urls, ["https://example.test/"]);
  assert.deepEqual(result.findings, []);
});

test("a sitemap that does not answer is a finding, and the rest of the index is still read", async () => {
  const site = server({
    "https://example.test/sitemap.xml": index("https://example.test/missing.xml", "https://example.test/pages.xml"),
    "https://example.test/missing.xml": 500,
    "https://example.test/pages.xml": urlset("https://example.test/"),
  });
  const result = await enumerateSitemaps({ sitemap: "https://example.test/sitemap.xml", fetch: site.fetch });
  assert.deepEqual(result.urls, ["https://example.test/"]);
  const problems = result.findings.filter((finding) => finding.id === "published-site.sitemap");
  assert.equal(problems.length, 1);
  assert.match(problems[0]!.message, /HTTP 500/);
});

test("a file with no <loc> and a file that is not sitemap XML are findings", async () => {
  const site = server({
    "https://example.test/empty.xml": urlset(),
    "https://example.test/html.xml": "<html></html>",
  });
  const empty = await enumerateSitemaps({ sitemap: "https://example.test/empty.xml", fetch: site.fetch });
  const html = await enumerateSitemaps({ sitemap: "https://example.test/html.xml", fetch: site.fetch });
  assert.deepEqual(empty.findings.map((finding) => finding.id), ["published-site.sitemap"]);
  assert.deepEqual(html.findings.map((finding) => finding.id), ["published-site.sitemap"]);
});

test("a .xml.gz sitemap is decompressed", async () => {
  const site = server({
    "https://example.test/sitemap.xml.gz": new Uint8Array(gzipSync(urlset("https://example.test/"))),
  });
  const result = await enumerateSitemaps({ sitemap: "https://example.test/sitemap.xml.gz", fetch: site.fetch });
  assert.deepEqual(result.urls, ["https://example.test/"]);
  assert.deepEqual(result.findings, []);
});

test("a file over the byte limit is a finding and yields no page URLs", async () => {
  const site = server({ "https://example.test/sitemap.xml": new Uint8Array(SITEMAP_MAX_BYTES + 1) });
  const result = await enumerateSitemaps({ sitemap: "https://example.test/sitemap.xml", fetch: site.fetch });
  assert.deepEqual(result.urls, []);
  assert.deepEqual(result.findings.map((finding) => finding.id), ["published-site.sitemap-limit"]);
});

test("a file with more <loc> values than the limit is a finding and yields no page URLs", async () => {
  const locs = Array.from({ length: SITEMAP_MAX_LOCS + 1 }, (_, i) => `https://example.test/${i}/`);
  const site = server({ "https://example.test/sitemap.xml": urlset(...locs) });
  const result = await enumerateSitemaps({ sitemap: "https://example.test/sitemap.xml", fetch: site.fetch });
  assert.deepEqual(result.urls, []);
  assert.deepEqual(result.findings.map((finding) => finding.id), ["published-site.sitemap-limit"]);
});

test("an index may read one hundred sitemap files, and the next is a finding", async () => {
  const files: Record<string, string> = {};
  const children: string[] = [];
  for (let i = 0; i < SITEMAP_MAX_FILES; i++) {
    const url = `https://example.test/${i}.xml`;
    children.push(url);
    files[url] = urlset(`https://example.test/page-${i}/`);
  }
  files["https://example.test/sitemap.xml"] = index(...children);
  const site = server(files);
  const result = await enumerateSitemaps({ sitemap: "https://example.test/sitemap.xml", fetch: site.fetch });
  assert.equal(result.urls.length, SITEMAP_MAX_FILES - 1);
  assert.equal(site.requested.length, SITEMAP_MAX_FILES);
  assert.deepEqual(result.findings.map((finding) => finding.id), ["published-site.sitemap-limit"]);
});

test("an index nested deeper than the depth limit is a finding", async () => {
  const files: Record<string, string> = {};
  const root = "https://example.test/0.xml";
  for (let depth = 0; depth <= SITEMAP_MAX_DEPTH + 1; depth++) {
    files[`https://example.test/${depth}.xml`] = index(`https://example.test/${depth + 1}.xml`);
  }
  files[`https://example.test/${SITEMAP_MAX_DEPTH + 2}.xml`] = urlset("https://example.test/");
  const site = server(files);
  const result = await enumerateSitemaps({ sitemap: root, fetch: site.fetch });
  assert.deepEqual(result.urls, []);
  assert.deepEqual(result.findings.map((finding) => finding.id), ["published-site.sitemap-limit"]);
});

test("more than the page URL limit is a finding, and the URLs before it are kept", async () => {
  const first = Array.from({ length: 25_001 }, (_, i) => `https://example.test/a-${i}/`);
  const second = Array.from({ length: 25_001 }, (_, i) => `https://example.test/b-${i}/`);
  const site = server({
    "https://example.test/sitemap.xml": index("https://example.test/a.xml", "https://example.test/b.xml"),
    "https://example.test/a.xml": urlset(...first),
    "https://example.test/b.xml": urlset(...second),
  });
  const result = await enumerateSitemaps({ sitemap: "https://example.test/sitemap.xml", fetch: site.fetch });
  assert.equal(result.urls.length, SITEMAP_MAX_URLS);
  assert.deepEqual(result.findings.map((finding) => finding.id), ["published-site.sitemap-limit"]);
});
