import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Diagnostic, Page, Site, SiteConfig } from "../src/contracts/index.ts";
import { socialImages } from "../src/outputs/social-images.ts";
import { ImageCache, imageKey } from "../src/social/cache.ts";

const ROOT = resolve(fileURLToPath(new URL("../fixtures/social-site", import.meta.url)));
const POS = { file: "index.md", line: 1, column: 1, endLine: 1, endColumn: 1 };
const FONTS = ["fonts/geist-sans-latin-400-normal.woff", "fonts/vazirmatn-arabic-400-normal.woff"];

function site(count: number, title = (i: number) => `Page number ${String(i)}`): Site {
  const pages = Array.from({ length: count }, (_, i) => ({
    url: `/p${String(i)}/`,
    title: title(i),
    frontMatter: { description: `About page ${String(i)}` },
    kind: "doc",
    source: POS,
  })) as unknown as Page[];
  const config = { title: "Evergreen", base: "", source: ".", url: "https://example.com", social: { template: "default", fonts: FONTS } } as unknown as SiteConfig;
  return { config, pages, nav: {}, data: {}, collections: {} } as unknown as Site;
}

async function run(s: Site, workers: number, cacheDir?: string) {
  const reports: Diagnostic[] = [];
  const files = await socialImages.run(s, {
    renderPage: async () => "",
    report: (d) => reports.push(d),
    build: { root: ROOT, workers, ...(cacheDir === undefined ? {} : { cacheDir }) },
  });
  return { files, reports, summary: reports.find((d) => d.id === "social.images")?.message ?? "" };
}

const digest = (files: readonly { path: string; contents: string | Uint8Array }[]): string =>
  createHash("sha256").update(files.map((f) => `${f.path}\0${createHash("sha256").update(f.contents).digest("hex")}`).join("\n")).digest("hex");

test("a second build reuses every image and writes the same bytes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mizzen-social-cache-"));
  try {
    const s = site(6);
    const first = await run(s, 1, dir);
    assert.match(first.summary, /6 drawn, 0 reused/);
    const second = await run(s, 1, dir);
    assert.match(second.summary, /0 drawn, 6 reused/);
    assert.equal(digest(second.files), digest(first.files));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("changing one page's title redraws only that page", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mizzen-social-cache-"));
  try {
    await run(site(6), 1, dir);
    const changed = await run(site(6, (i) => (i === 2 ? "A new title" : `Page number ${String(i)}`)), 1, dir);
    assert.match(changed.summary, /1 drawn, 5 reused/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a damaged cache entry is a miss, not a broken image", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mizzen-social-cache-"));
  try {
    const s = site(1);
    const first = await run(s, 1, dir);
    for (const entry of readdirSync(join(dir, "social-images"), { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".png")) writeFileSync(join(entry.parentPath, entry.name), "half");
    }
    const again = await run(s, 1, dir);
    assert.match(again.summary, /1 drawn, 0 reused/);
    assert.equal(digest(again.files), digest(first.files));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one worker and four workers write identical bytes in identical order", async () => {
  const s = site(16);
  const one = await run(s, 1);
  const four = await run(s, 4);
  assert.deepEqual(four.files.map((f) => f.path), one.files.map((f) => f.path));
  assert.equal(digest(four.files), digest(one.files));
  assert.equal(four.reports.some((d) => d.id === "social.worker-failed"), false);
});

test("pages with the same text share one drawing", async () => {
  const s = site(5, () => "Same title");
  const same = { ...s, pages: s.pages.map((p) => ({ ...p, frontMatter: {} })) } as Site;
  const result = await run(same, 1);
  assert.match(result.summary, /1 drawn/);
  assert.equal(result.files.length, 5);
});

test("the key follows the template, the fonts, and each value", () => {
  const base = imageKey("t", "f", { a: "1", b: "2" });
  assert.equal(base, imageKey("t", "f", { b: "2", a: "1" }));
  assert.notEqual(base, imageKey("t2", "f", { a: "1", b: "2" }));
  assert.notEqual(base, imageKey("t", "f2", { a: "1", b: "2" }));
  assert.notEqual(base, imageKey("t", "f", { a: "1", b: "3" }));
});

test("an unwritable cache folder does not fail the build", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mizzen-social-cache-"));
  try {
    writeFileSync(join(dir, "social-images"), "a file where the folder should be");
    const cache = new ImageCache(dir);
    await cache.set("ab".repeat(32), { png: new Uint8Array(30), outcomes: [] });
    assert.equal(await cache.get("ab".repeat(32)), undefined);
    mkdirSync(join(dir, "x"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
