import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Diagnostic, Page, Site, SiteConfig } from "../src/contracts/index.ts";
import { headMeta } from "../src/outputs/head-meta.ts";
import { socialImages } from "../src/outputs/social-images.ts";
import { socialImageFile, socialImagePath } from "../src/social/image-path.ts";

const ROOT = resolve(fileURLToPath(new URL("../fixtures/social-site", import.meta.url)));
const FONTS = ["fonts/geist-sans-latin-400-normal.woff", "fonts/vazirmatn-arabic-400-normal.woff"];

const POS = { file: "index.md", line: 1, column: 1, endLine: 1, endColumn: 1 };

function page(url: string, title: string, frontMatter: Record<string, unknown> = {}, extra: Partial<Page> = {}): Page {
  return { url, title, frontMatter, lang: "en", dir: "ltr", kind: "doc", source: POS, headings: [], html: "", markdown: "", ...extra } as unknown as Page;
}

function site(pages: Page[], social: SiteConfig["social"] | undefined, extra: Partial<SiteConfig> = {}): Site {
  const config = {
    title: "Evergreen",
    description: "A docs site",
    base: "/docs",
    url: "https://example.com",
    source: ".",
    lang: "en",
    languages: [],
    ...(social === undefined ? {} : { social }),
    ...extra,
  } as unknown as SiteConfig;
  return { config, pages, nav: {}, data: {}, collections: {} } as unknown as Site;
}

async function run(s: Site, withBuild = true, build: { workers?: number; cacheDir?: string } = {}) {
  const all: Diagnostic[] = [];
  const files = await socialImages.run(s, {
    renderPage: async () => "",
    report: (d) => all.push(d),
    ...(withBuild ? { build: { root: ROOT, workers: build.workers ?? 1, ...(build.cacheDir === undefined ? {} : { cacheDir: build.cacheDir }) } } : {}),
  });
  return { files, diagnostics: all.filter((d) => d.id !== "social.images"), summary: all.find((d) => d.id === "social.images")?.message };
}

const sha = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const social = { template: "default", fonts: FONTS };
const pages = [
  page("/docs/", "Home"),
  page("/docs/guide/install/", "Install Evergreen"),
  page("/docs/people/ada/", "Ada Lovelace", {}, { kind: "doc", record: { collection: "people", id: "ada", fields: {} } } as unknown as Partial<Page>),
];

test("one PNG per page, sorted, at the path the head points at", async () => {
  const s = site(pages, social);
  const { files, diagnostics } = await run(s);
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(files.map((f) => f.path), ["assets/social/guide/install.png", "assets/social/index.png", "assets/social/people/ada.png"]);
  for (const file of files) {
    assert.ok(file.contents instanceof Uint8Array);
    assert.equal(Buffer.from(file.contents).readUInt32BE(16), 1200);
  }
  for (const p of pages) {
    assert.ok(files.some((f) => f.path === socialImageFile(s, p)));
  }
  assert.equal(socialImagePath(s, pages[1]!), "/docs/assets/social/guide/install.png");
});

test("the same site gives the same bytes twice", async () => {
  const s = site(pages, social);
  const a = await run(s);
  const b = await run(s);
  assert.deepEqual(a.files.map((f) => sha(f.contents)), b.files.map((f) => sha(f.contents)));
});

test("the head points at the image with its size, and the card is large", () => {
  const s = site(pages, social);
  const head = headMeta(s, pages[1]!, []);
  const get = (n: string) => head.meta.find((m) => m.name === n)?.content;
  assert.equal(get("og:image"), "https://example.com/docs/assets/social/guide/install.png");
  assert.equal(get("og:image:width"), "1200");
  assert.equal(get("og:image:height"), "630");
  assert.equal(get("twitter:card"), "summary_large_image");
  assert.equal(JSON.stringify(head.jsonLd).includes("assets/social/guide/install.png"), true);
});

test("a page's own image wins, and og: false keeps the head without one", () => {
  const own = page("/docs/a/", "A", { image: "/docs/own.png" });
  const head = headMeta(site([own], social), own, []);
  assert.equal(head.meta.find((m) => m.name === "og:image")?.content, "https://example.com/docs/own.png");
  assert.equal(head.meta.some((m) => m.name === "og:image:width"), false);
  const off = page("/docs/b/", "B", { og: false });
  assert.equal(headMeta(site([off], social), off, []).meta.some((m) => m.name === "og:image"), false);
});

test("a page with its own image or with social: false gets no generated file", async () => {
  const own = page("/docs/a/", "A", { image: "/docs/own.png" });
  const { files } = await run(site([own, page("/docs/b/", "B", { social: false }), page("/docs/c/", "C")], social));
  assert.deepEqual(files.map((f) => f.path), ["assets/social/c.png"]);
});

test("a site without the social key draws nothing and the head is unchanged", async () => {
  const s = site(pages, undefined);
  assert.deepEqual((await run(s)).files, []);
  const head = headMeta(s, pages[1]!, []);
  assert.equal(head.meta.some((m) => m.name === "og:image"), false);
  assert.equal(head.meta.find((m) => m.name === "twitter:card")?.content, "summary");
});

test("a front matter social: false turns one page off, and a name picks another template", async () => {
  const s = site([page("/docs/a/", "A", { social: false }), page("/docs/b/", "B"), page("/docs/c/", "C", { social: "nope" })], social);
  const { files, diagnostics } = await run(s);
  assert.deepEqual(files.map((f) => f.path), ["assets/social/b.png"]);
  assert.deepEqual(diagnostics.map((d) => d.id), ["social.template-missing"]);
  assert.equal(socialImageFile(s, s.pages[0]!), undefined);
});

test("a site without url writes the images and the head has no absolute image", async () => {
  const s = site(pages, social, { url: undefined } as unknown as Partial<SiteConfig>);
  assert.equal((await run(s)).files.length, 3);
  assert.equal(headMeta(s, pages[1]!, []).meta.some((m) => m.name === "og:image"), false);
});

test("a character no font draws is reported with the page, and a long title is reported as cut", async () => {
  const hard = page("/docs/h/", "日本語 " + "word ".repeat(60));
  const { files, diagnostics } = await run(site([hard], social));
  assert.equal(files.length, 1);
  assert.deepEqual(diagnostics.map((d) => d.id).sort(), ["social.missing-glyph", "social.truncated"]);
  assert.equal(diagnostics.every((d) => d.pos?.file === "index.md"), true);
});

test("a missing font is reported, and no system font stands in", async () => {
  const { files, diagnostics } = await run(site([pages[0]!], { template: "default", fonts: ["fonts/none.woff"] }));
  assert.equal(files.length, 1);
  assert.equal(diagnostics.some((d) => d.id === "social.font-missing"), true);
});

test("a run without build facts does nothing", async () => {
  assert.deepEqual((await run(site(pages, social), false)).files, []);
});

test("an app page and a page named with odd characters never collide or escape the folder", () => {
  const s = site([], social);
  const names = [page("/docs/a%20b/", "x"), page("/docs/../x/", "y"), page("/docs/a-b/", "z")].map((p) => socialImageFile(s, p));
  assert.deepEqual(names, ["assets/social/a b.png", "assets/social/x.png", "assets/social/a-b.png"]);
  assert.equal(socialImageFile(s, page("/docs/f.bin", "f", {}, { kind: "asset" })), undefined);
});
