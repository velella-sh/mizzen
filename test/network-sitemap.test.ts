/** `mizzen network sitemap`: one index pointing at each public project's sitemap, a robots line, hidden projects left out. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runNetwork } from "../src/cli/network.ts";
import { sitemapIndexText } from "../src/network/sitemap.ts";
import { lockOf, networkSite } from "./helpers-network.ts";

async function run(...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runNetwork(["sitemap", ...args], { log: (m) => out.push(m), error: (m) => err.push(m) });
  return { code, out, err };
}

test("the index lists each public project's sitemap, sorted, and never merges their URLs", async () => {
  const root = await networkSite();
  const dest = mkdtempSync(join(tmpdir(), "mizzen-netmap-"));
  const result = await run(root, "--url", "https://example.org", "--out", dest);
  assert.equal(result.code, 0, result.err.join("\n"));
  const xml = readFileSync(join(dest, "sitemap.xml"), "utf8");
  assert.equal(xml, [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    "  <sitemap>", "    <loc>https://example.org/blog/sitemap.xml</loc>", "  </sitemap>",
    "  <sitemap>", "    <loc>https://example.org/docs/sitemap.xml</loc>", "  </sitemap>",
    "</sitemapindex>", "",
  ].join("\n"));
  assert.ok(!xml.includes("<url>"));
});

test("a project that is not public is left out", async () => {
  assert.ok(!sitemapIndexText("https://example.org", lockOf().projects).includes("internal"));
});

test("robots.txt names the index", async () => {
  const dest = mkdtempSync(join(tmpdir(), "mizzen-netmap-"));
  await run(await networkSite(), "--url", "https://example.org/", "--out", dest);
  assert.equal(readFileSync(join(dest, "robots.txt"), "utf8"), "User-agent: *\nAllow: /\n\nSitemap: https://example.org/sitemap.xml\n");
});

test("two runs write the same bytes, and the origin comes from an https source", async () => {
  const root = await networkSite();
  const a = mkdtempSync(join(tmpdir(), "mizzen-netmap-"));
  const b = mkdtempSync(join(tmpdir(), "mizzen-netmap-"));
  await run(root, "--out", a);
  await run(root, "--out", b);
  assert.equal(readFileSync(join(a, "sitemap.xml"), "utf8"), readFileSync(join(b, "sitemap.xml"), "utf8"));
  assert.match(readFileSync(join(a, "sitemap.xml"), "utf8"), /https:\/\/example\.org\/docs\/sitemap\.xml/);
});

test("a missing lock or a bad option is reported", async () => {
  assert.equal((await run(mkdtempSync(join(tmpdir(), "mizzen-netmap-")), "--url", "https://example.org")).code, 1);
  assert.equal((await run("--bogus")).code, 2);
});
