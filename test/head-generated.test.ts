/**
 * The head of every page of one site that sets a base path, analytics, social images, a collection with `seo`, a blog,
 * and an API reference: the engine's own pages carry a description, and every page has the Open Graph and Twitter
 * tags, an absolute social image under the base, and its structured data.
 */
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "../src/pipeline/build.ts";

const THEME = fileURLToPath(new URL("../../lateen", import.meta.url));
const SOCIAL = fileURLToPath(new URL("../fixtures/social-site", import.meta.url));

const FILES: Record<string, string> = {
  "mizzen.yml": [
    "title: Fixture",
    "url: https://example.com",
    "base: /docs",
    "description: A fixture site",
    "analytics:",
    "  provider: plausible",
    "  site: example.com",
    "social:",
    "  template: default",
    "  fonts:",
    "    - fonts/geist-sans-latin-400-normal.woff",
    "blog:",
    "  posts: posts",
    "apiReference:",
    "  source: api/openapi.yaml",
    "collections:",
    "  things:",
    "    source: _data/things.yml",
    "    template: _templates/things.md",
    "    permalink: /things/{id}/",
    "    seo:",
    "      jsonLd:",
    '        "@type": Product',
    '        name: "{title}"',
    "",
  ].join("\n"),
  "_data/things.yml": "- id: a\n  title: Alpha\n",
  "_data/authors.yml": "armin:\n  name: Armin\n",
  "_templates/things.md": '---\ntitle: "{title}"\ndescription: "About {title}"\n---\n# :field[title]\n',
  "index.md": "---\ntitle: Home\n---\n# Home\n",
  "guide.md": "---\ntitle: Guide\ndescription: The guide\n---\n# Guide\n",
  "things/index.md": "---\ntitle: Things\ndescription: All things\nlist:\n  collection: things\n---\n# Things\n",
  "posts/one.md": "---\ntitle: One\ndate: 2026-01-12\nauthor: armin\ndescription: First.\n---\n\nBody.\n",
  "api/openapi.yaml":
    "openapi: 3.1.0\ninfo:\n  title: Pet API\n  version: 1.0.0\npaths:\n  /pets:\n    get:\n      operationId: listPets\n      summary: List pets\n      responses:\n        '200':\n          description: OK\n",
};

test("every page of a site with a base path has the social and structured head, and generated pages a description", async () => {
  const root = mkdtempSync(join(tmpdir(), "head-generated-"));
  try {
    cpSync(join(SOCIAL, "_templates"), join(root, "_templates"), { recursive: true });
    cpSync(join(SOCIAL, "fonts"), join(root, "fonts"), { recursive: true });
    for (const [path, text] of Object.entries(FILES)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    const out = join(root, "_out");
    const result = await build({ root, out, themeRoot: THEME, defaultLayout: "doc" });
    const pages = result.files.filter((file) => file.endsWith("index.html") && !file.startsWith("assets/"));
    assert.ok(pages.length >= 8, `built ${pages.join(", ")}`);
    for (const file of pages) {
      const text = readFileSync(join(out, file), "utf8");
      const head = /<head>([\s\S]*?)<\/head>/.exec(text)?.[1] ?? "";
      const label = `${file}`;
      if (/http-equiv="refresh"/.test(head)) continue; // a redirect stub, not a page
      for (const name of ["og:type", "og:title", "og:url", "og:site_name"]) {
        assert.match(head, new RegExp(`<meta property="${name}" `), `${label}: ${name} is a property tag`);
      }
      assert.doesNotMatch(head, /<meta name="og:/, `${label}: no og tag as a name`);
      assert.match(head, /<meta name="twitter:card" content="summary_large_image"/, label);
      const image = /<meta property="og:image" content="([^"]+)"/.exec(head)?.[1];
      assert.ok(image?.startsWith("https://example.com/docs/assets/social/"), `${label}: absolute og:image under the base (${image})`);
      assert.match(head, /<meta property="og:image:width" content="1200"/, label);
      assert.equal([...head.matchAll(/<meta name="description"/g)].length, 1, `${label}: one description`);
      assert.equal([...head.matchAll(/rel="canonical"/g)].length, 1, `${label}: one canonical`);
      const types = [...head.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]!)["@type"]);
      assert.ok(types.includes("WebSite") || types.includes("TechArticle"), `${label}: WebSite or TechArticle`);
    }
    const ld = (path: string): unknown[] =>
      [...readFileSync(join(out, path), "utf8").matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]!)["@type"]);
    assert.ok(ld("things/a/index.html").includes("Product"), "the collection's seo.jsonLd");
    assert.ok(ld("things/index.html").includes("ItemList"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the blog archive, an author page, and the API reference pages describe themselves", async () => {
  const root = mkdtempSync(join(tmpdir(), "head-generated-"));
  try {
    for (const [path, text] of Object.entries(FILES)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    const out = join(root, "_out");
    const result = await build({ root, out, themeRoot: THEME, defaultLayout: "doc" });
    const description = (file: string): string | undefined =>
      /<meta name="description" content="([^"]*)"/.exec(readFileSync(join(out, file), "utf8"))?.[1];
    const blog = result.files.filter((file) => /^blog\/(archive|authors\/armin)\/index\.html$/.test(file));
    assert.equal(blog.length, 2, result.files.join(", "));
    for (const file of blog) assert.ok(description(file), `${file} has a description`);
    assert.equal(description("blog/archive/index.html"), "All 1 post.");
    const reference = result.files.filter((file) => file.startsWith("reference/") && file.endsWith("index.html"));
    assert.ok(reference.length >= 2, result.files.join(", "));
    for (const file of reference) assert.ok(description(file), `${file} has a description`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
