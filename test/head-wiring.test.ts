import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { headMeta } from "../src/outputs/head-meta.ts";
import { build } from "../src/pipeline/build.ts";
import { plannedSocialImages } from "../src/social/plan.ts";
import { pageAt, withSite } from "./data-record-site.ts";

const THEME = fileURLToPath(new URL("../../lateen", import.meta.url));
const SOCIAL = fileURLToPath(new URL("../fixtures/social-site", import.meta.url));

const CONFIG = [
  "title: Fixture",
  "url: https://example.com",
  "description: A fixture site",
  "social:",
  "  template: default",
  "  fonts:",
  "    - fonts/geist-sans-latin-400-normal.woff",
  "collections:",
  "  posts:",
  "    source: _data/posts.yml",
  "    template: _templates/posts.md",
  "    permalink: /posts/{id}/",
  "    seo:",
  "      noindex: hidden",
  "      canonical: canon",
  "      jsonLd:",
  '        "@type": BlogPosting',
  '        headline: "{title}"',
  "",
].join("\n");

const POSTS = "- id: a\n  title: Alpha\n  canon: https://example.com/original/a/\n- id: b\n  title: Beta <b>\n  hidden: true\n";

function files(extra: Record<string, string> = {}, config = CONFIG): Record<string, string> {
  return {
    "mizzen.yml": config,
    "_data/posts.yml": POSTS,
    "_templates/posts.md": '---\ntitle: "{title}"\ndescription: "About {title}"\n---\n# :field[title]\n',
    "index.md": "---\ntitle: Home\n---\n# Home\n",
    "docs/guide.md": "---\ntitle: Guide\ndescription: The guide\n---\n# Guide\n",
    "blog/index.md": "---\ntitle: Blog\nlist:\n  collection: posts\n  perPage: 1\n---\n# Blog\n",
    ...extra,
  };
}

function tree(map: Record<string, string>, withTemplate = true): string {
  const root = mkdtempSync(join(tmpdir(), "head-wiring-"));
  if (withTemplate) {
    cpSync(join(SOCIAL, "_templates"), join(root, "_templates"), { recursive: true });
    cpSync(join(SOCIAL, "fonts"), join(root, "fonts"), { recursive: true });
  }
  for (const [path, text] of Object.entries(map)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rel of readdirSync(dir, { recursive: true }) as string[]) {
    const abs = join(dir, rel);
    if (statSync(abs).isFile()) out.set(rel.split("\\").join("/"), createHash("sha256").update(readFileSync(abs)).digest("hex"));
  }
  return out;
}

const html = (out: string, path: string): string => readFileSync(join(out, path, "index.html"), "utf8");
const head = (text: string): string => /<head>([\s\S]*?)<\/head>/.exec(text)![1]!;
const count = (text: string, pattern: RegExp): number => [...head(text).matchAll(pattern)].length;
const ldOf = (text: string): string[] => [...head(text).matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]!);

async function built(root: string, extra: Record<string, unknown> = {}): Promise<{ out: string; parent: string }> {
  const parent = mkdtempSync(join(tmpdir(), "head-wiring-out-"));
  const out = join(parent, "site");
  await build({ root, out, themeRoot: THEME, defaultLayout: "doc", ...extra });
  return { out, parent };
}

test("a built page names the social image the build wrote, and its JSON-LD is valid", async () => {
  const root = tree(files());
  const { out, parent } = await built(root);
  try {
    for (const path of ["docs/guide", "posts/a", "blog"]) {
      const text = html(out, path);
      const image = /<meta property="og:image" content="([^"]+)"/.exec(text)?.[1];
      assert.ok(image, `${path} has og:image`);
      assert.ok(image.startsWith("https://example.com/assets/social/"));
      assert.ok(existsSync(join(out, new URL(image).pathname)), `${path}: ${image} is in the output`);
      assert.equal(count(text, /<meta name="twitter:card" content="summary_large_image"/g), 1);
      assert.equal(count(text, /rel="canonical"/g), 1, `${path} has one canonical`);
      assert.equal(count(text, /<meta name="description"/g) <= 1, true);
      for (const data of ldOf(text)) {
        assert.ok(!data.includes("<"), "JSON-LD never holds a raw <");
        assert.equal(typeof JSON.parse(data)["@type"], "string");
      }
    }
    const guide = ldOf(html(out, "docs/guide")).map((data) => JSON.parse(data)["@type"]);
    assert.ok(guide.includes("TechArticle"));
    const post = ldOf(html(out, "posts/a")).map((data) => JSON.parse(data));
    assert.ok(post.some((data) => data["@type"] === "BlogPosting" && data.headline === "Alpha"), "the collection's seo.jsonLd");
    assert.ok(ldOf(html(out, "blog")).some((data) => JSON.parse(data)["@type"] === "ItemList"), "a list page has an ItemList");
    // The record's own canonical field wins over the page URL, once.
    assert.match(html(out, "posts/a"), /<link rel="canonical" href="https:\/\/example.com\/original\/a\/"/);
    // `<` in a record value is escaped, not printed.
    const hidden = html(out, "posts/b");
    assert.ok(ldOf(hidden).some((data) => data.includes("Beta \\u003cb>")));
    assert.equal(count(hidden, /<meta name="robots"/g), 1, "seo.noindex writes one robots tag");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("the head names no social image when the output is off, the page opts out, or the template does not load", async () => {
  const cases: { label: string; map: Record<string, string>; template: boolean }[] = [
    { label: "output off", map: files({}, `${CONFIG}outputs:\n  social-images: false\n`), template: true },
    { label: "template missing", map: files(), template: false },
    { label: "page opted out", map: files({ "docs/guide.md": "---\ntitle: Guide\nsocial: false\n---\n# Guide\n" }), template: true },
  ];
  for (const { label, map, template } of cases) {
    const root = tree(map, template);
    const { out, parent } = await built(root);
    try {
      const text = html(out, "docs/guide");
      assert.doesNotMatch(text, /og:image/, `${label}: no og:image`);
      assert.match(text, /<meta name="twitter:card" content="summary"\/?>/, `${label}: a summary card`);
      assert.equal(JSON.parse(ldOf(text)[0]!).image, undefined, `${label}: no image in the structured data`);
      if (label === "page opted out") assert.match(html(out, "blog"), /og:image/, "other pages keep theirs");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(parent, { recursive: true, force: true });
    }
  }
});

test("an incremental build after a seo-mapped field changes writes the bytes of a full build", async () => {
  const root = tree(files());
  const parent = mkdtempSync(join(tmpdir(), "head-wiring-inc-"));
  const cacheDir = join(parent, "cache");
  const run = (name: string, cached: boolean) =>
    build({ root, out: join(parent, name), themeRoot: THEME, defaultLayout: "doc", ...(cached ? { cache: true, cacheDir } : {}) });
  try {
    await run("cached-one", true);
    const before = readFileSync(join(parent, "cached-one/posts/a/index.html"), "utf8");
    writeFileSync(
      join(root, "_data/posts.yml"),
      "- id: a\n  title: Alpha two\n  canon: https://example.com/moved/a/\n- id: b\n  title: Beta <b>\n  hidden: false\n",
    );
    await run("cached-two", true);
    await run("full-two", false);
    const after = readFileSync(join(parent, "cached-two/posts/a/index.html"), "utf8");
    assert.notEqual(after, before, "the change reached the page");
    assert.match(after, /moved\/a\//);
    assert.match(after, /"headline":"Alpha two"/);
    assert.deepEqual(snapshot(join(parent, "cached-two")), snapshot(join(parent, "full-two")));

    // Dropping the social template retires the og:image the cached pages named.
    rmSync(join(root, "_templates/social"), { recursive: true, force: true });
    await run("cached-three", true);
    await run("full-three", false);
    assert.doesNotMatch(readFileSync(join(parent, "cached-three/docs/guide/index.html"), "utf8"), /og:image/);
    assert.deepEqual(snapshot(join(parent, "cached-three")), snapshot(join(parent, "full-three")));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a build is deterministic with the head wired in", async () => {
  const root = tree(files());
  const one = await built(root);
  const two = await built(root);
  try {
    assert.deepEqual(snapshot(one.out), snapshot(two.out));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(one.parent, { recursive: true, force: true });
    rmSync(two.parent, { recursive: true, force: true });
  }
});

const robots = (value: ReturnType<typeof headMeta>): string[] => value.meta.filter((tag) => tag.name === "robots").map((tag) => tag.content);
const canonicals = (value: ReturnType<typeof headMeta>): string[] => value.links.filter((link) => link.rel === "canonical").map((link) => link.href);
const descriptions = (value: ReturnType<typeof headMeta>): number => value.meta.filter((tag) => tag.name === "description").length;

test("headMeta gives one canonical, one robots, and one description for docs, record, and list pages", async () => {
  await withSite(files(), async (_root, result) => {
    const site = result.site;
    const trail = [{ title: "Posts", url: "/blog/" }];
    for (const url of ["/docs/guide/", "/posts/a/", "/blog/"]) {
      const value = headMeta(site, pageAt(result, url)!, trail);
      assert.equal(canonicals(value).length, 1, `${url}: one canonical`);
      assert.ok(descriptions(value) <= 1, `${url}: at most one description`);
      assert.ok(robots(value).length <= 1, `${url}: at most one robots`);
      assert.equal(value.title, pageAt(result, url)!.title);
    }
    const list = headMeta(site, pageAt(result, "/blog/")!, trail).jsonLd.map((data) => data["@type"]);
    assert.deepEqual(list, ["TechArticle", "BreadcrumbList", "ItemList"]);
    const record = headMeta(site, pageAt(result, "/posts/a/")!, []).jsonLd.map((data) => data["@type"]);
    assert.deepEqual(record, ["TechArticle", "BlogPosting"]);
  });
});

test("a preview and a record's seo.noindex together still write one robots tag, and the preview canonical wins once", async () => {
  await withSite(files(), async (_root, result) => {
    const previewSite = { ...result.site, preview: { canonicalBase: "https://docs.example.com", commit: "abc" } };
    const hidden = headMeta(previewSite as typeof result.site, pageAt(result, "/posts/b/")!, []);
    assert.deepEqual(robots(hidden), ["noindex"]);
    assert.deepEqual(canonicals(hidden), ["https://docs.example.com/posts/b/"]);
    const plain = headMeta(previewSite as typeof result.site, pageAt(result, "/docs/guide/")!, []);
    assert.deepEqual(robots(plain), ["noindex"]);
    const own = headMeta(result.site, pageAt(result, "/posts/b/")!, []);
    assert.deepEqual(robots(own), ["noindex"], "seo.noindex alone is the same one tag");
  });
});

test("headMeta carries the hreflang alternates and OpenSearch link the build used to add by itself", async () => {
  await withSite(files({ "mizzen.yml": `${CONFIG}languages:\n  - code: en\n    name: English\n    prefix: \"\"\n  - code: fr\n    name: French\n    prefix: /fr\n` }), async (_root, result) => {
    const value = headMeta(result.site, pageAt(result, "/docs/guide/")!, []);
    assert.ok(value.links.some((link) => link.rel === "search"), "OpenSearch link");
  });
});

test("headMeta names a social image only for the pages the build writes one for", async () => {
  await withSite(files(), async (_root, result) => {
    const guide = pageAt(result, "/docs/guide/")!;
    const ogImage = (value: ReturnType<typeof headMeta>) => value.meta.find((tag) => tag.name === "og:image")?.content;
    assert.equal(ogImage(headMeta(result.site, guide, [])), "https://example.com/assets/social/docs/guide.png", "no list: the config decides");
    assert.equal(ogImage(headMeta(result.site, guide, [], new Set(["/docs/guide/"]))), "https://example.com/assets/social/docs/guide.png");
    const none = headMeta(result.site, guide, [], new Set());
    assert.equal(ogImage(none), undefined);
    assert.equal(none.meta.find((tag) => tag.name === "twitter:card")?.content, "summary");
    assert.equal(none.jsonLd[0]!.image, undefined);
  });
});

test("plannedSocialImages lists the pages whose template loads and nothing when the output is off", async () => {
  const root = tree(files({ "docs/guide.md": "---\ntitle: Guide\nsocial: false\n---\n# Guide\n" }));
  try {
    const { buildModel } = await import("../src/model/build.ts");
    const { site } = await buildModel(root);
    const planned = await plannedSocialImages(site, root);
    assert.ok(planned.has("/blog/") && planned.has("/posts/a/"));
    assert.ok(!planned.has("/docs/guide/"));
    const off = { ...site, config: { ...site.config, outputs: { "social-images": false } } };
    assert.equal((await plannedSocialImages(off, root)).size, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
