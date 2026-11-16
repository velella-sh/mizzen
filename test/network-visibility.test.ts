/** One flag, `public`, decides what every shared output shows: flipping it changes them all together. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runNetwork } from "../src/cli/network.ts";
import { buildModel } from "../src/model/build.ts";
import { sitemapIndexText } from "../src/network/sitemap.ts";
import { searchMerge } from "../src/outputs/search-merge.ts";
import { lockOf, networkSite } from "./helpers-network.ts";
import { writeFileSync } from "node:fs";

const ctx = { renderPage: async () => "", report: () => {} };

async function seen(isPublic: boolean) {
  const lock = lockOf();
  const flipped = { ...lock, projects: lock.projects.map((p) => (p.id === "internal" ? { ...p, public: isPublic } : p)) };
  const root = await networkSite("", flipped);
  const { site } = await buildModel(root);
  const merge = await searchMerge.run(site, ctx);
  const dest = mkdtempSync(join(tmpdir(), "mizzen-netvis-"));
  await runNetwork(["sitemap", root, "--url", "https://example.org", "--out", dest], { log: () => {}, error: () => {} });
  return {
    theme: site.network?.projects.map((p) => p.id) ?? [],
    search: JSON.parse(String(merge[0]!.contents)).others.map((p: { id: string }) => p.id) as string[],
    sitemap: [...readFileSync(join(dest, "sitemap.xml"), "utf8").matchAll(/<loc>[^<]*\/([a-z]+)\/sitemap\.xml/g)].map((m) => m[1]!),
  };
}

test("flipping a project from hidden to public shows it in the theme list, the merged search, and the sitemap index", async () => {
  const hidden = await seen(false);
  assert.deepEqual(hidden, { theme: ["docs", "blog"], search: ["blog"], sitemap: ["blog", "docs"] });
  const open = await seen(true);
  assert.deepEqual(open, { theme: ["docs", "blog", "internal"], search: ["blog", "internal"], sitemap: ["blog", "docs", "internal"] });
});

test("a hidden project's own build works and links to its own pages", async () => {
  const root = await networkSite("", lockOf(), "internal");
  writeFileSync(join(root, "own.md"), "---\ntitle: Own\n---\nSee [guide](guide/index.md).\n");
  const { site, diagnostics } = await buildModel(root);
  assert.deepEqual(diagnostics.filter((d) => d.severity === "error"), []);
  assert.equal(site.config.base, "/internal");
  assert.ok(site.pages.some((p) => p.url === "/internal/guide/"));
  assert.deepEqual(site.network?.projects.map((p) => p.id), ["docs", "blog"]);
});

test("a public project's link to a hidden one fails", async () => {
  const root = await networkSite();
  writeFileSync(join(root, "own.md"), "---\ntitle: Own\n---\n[[internal:/]]\n");
  const { diagnostics } = await buildModel(root);
  assert.equal(diagnostics.find((d) => d.id === "network.link-hidden")?.severity, "error");
  assert.ok(!sitemapIndexText("https://example.org", lockOf().projects).includes("internal"));
});
