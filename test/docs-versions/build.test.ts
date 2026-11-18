/**
 * The public build with versioned docs: the release named default answers at the unprefixed URL, every version keeps its
 * prefixed URL, and the canonical link, the sitemap, and `versions.json` name one URL per page.
 *
 * Acceptance case `024-build-integration-4` for the #862 release gate: the test renderer reads
 * `page.frontMatter.canonical_url` and `page.aliasOf`, both public model fields.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { build } from "../../src/pipeline/build.ts";

function tree(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

const THEME = {
  "src/index.ts": 'export const theme = { name: "t", folders: ["layouts"] };\n',
  "layouts/doc.ts":
    'export default (p: any) => { const canonical = p.page.frontMatter.canonical_url ?? p.page.url; return `<html><head><link rel="canonical" href="https://example.org${canonical}"></head><body>${p.page.html}</body></html>`; };\n',
};

/** A site whose current docs and two releases say which one a reader sees at `/guide/install/`. */
async function buildSite(parent: string, versions: string): Promise<{ out: string; errors: readonly string[] }> {
  const theme = join(parent, "theme");
  tree(theme, THEME);
  const site = join(parent, "site");
  tree(site, {
    "mizzen.yml":
      'title: Versioned\ndescription: Three install pages.\nurl: https://example.org\ndefaults:\n  - path: ""\n    values:\n      layout: doc\n',
    "_data/versions.yml": versions,
    "guide/install.md": "---\ntitle: Install\n---\n\nCurrent install.\n",
    "v1/guide/install.md": "---\ntitle: Install v1\n---\n\nVersion 1 install.\n",
    "v2/guide/install.md": "---\ntitle: Install v2\n---\n\nVersion 2 install.\n",
  });
  const out = join(parent, "out");
  const result = await build({ root: site, out, themeRoot: theme, defaultLayout: "doc" });
  return { out, errors: result.diagnostics.filter((d) => d.severity === "error").map((d) => d.id) };
}

/** Every `<loc>` the sitemap lists. */
function locs(out: string): string[] {
  return [...readFileSync(join(out, "sitemap.xml"), "utf8").matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1] ?? "");
}

test("with v2 default, the unprefixed URL, the canonical link, the sitemap, and versions.json agree", async () => {
  const parent = mkdtempSync(join(tmpdir(), "docs-versions-build-"));
  try {
    const { out, errors } = await buildSite(parent, "default: v2\nold: [v1]\n");
    assert.deepEqual(errors, []);

    const canonical = readFileSync(join(out, "guide/install/index.html"), "utf8");
    assert.match(canonical, /Version 2 install\./);
    assert.match(canonical, /<link rel="canonical" href="https:\/\/example\.org\/guide\/install\/">/);

    const versioned = readFileSync(join(out, "v2/guide/install/index.html"), "utf8");
    assert.match(versioned, /Version 2 install\./);
    assert.match(versioned, /<link rel="canonical" href="https:\/\/example\.org\/guide\/install\/">/);

    assert.match(readFileSync(join(out, "v1/guide/install/index.html"), "utf8"), /Version 1 install\./);

    const listed = locs(out);
    assert.ok(listed.includes("https://example.org/guide/install/"));
    assert.ok(listed.includes("https://example.org/v1/guide/install/"));
    assert.equal(listed.includes("https://example.org/v2/guide/install/"), false, "the alias is not a second sitemap entry");

    const versions = JSON.parse(readFileSync(join(out, "versions.json"), "utf8")) as {
      pages: { path: string; versions: { version: string; url: string }[] }[];
      byUrl: Record<string, string>;
    };
    assert.deepEqual(versions.pages, [
      {
        path: "guide/install.md",
        versions: [
          { version: "v1", url: "/v1/guide/install/" },
          { version: "v2", url: "/v2/guide/install/" },
        ],
      },
    ]);
    assert.deepEqual(versions.byUrl, { "/v1/guide/install/": "guide/install.md", "/v2/guide/install/": "guide/install.md" });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("switching the default serves the other release at the unprefixed URL and leaves its versioned URL alone", async () => {
  const parent = mkdtempSync(join(tmpdir(), "docs-versions-build-"));
  try {
    const { out, errors } = await buildSite(parent, "default: v1\nold: [v2]\n");
    assert.deepEqual(errors, []);

    const canonical = readFileSync(join(out, "guide/install/index.html"), "utf8");
    assert.match(canonical, /Version 1 install\./);
    assert.equal(canonical.includes("Version 2 install."), false);
    assert.match(readFileSync(join(out, "v1/guide/install/index.html"), "utf8"), /Version 1 install\./);

    const old = readFileSync(join(out, "v2/guide/install/index.html"), "utf8");
    assert.match(old, /Version 2 install\./);
    // An old release no longer owns a canonical URL; its own versioned URL is canonical.
    assert.match(old, /<link rel="canonical" href="https:\/\/example\.org\/v2\/guide\/install\/">/);

    const listed = locs(out);
    assert.ok(listed.includes("https://example.org/guide/install/"));
    assert.ok(listed.includes("https://example.org/v2/guide/install/"));
    assert.equal(listed.includes("https://example.org/v1/guide/install/"), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
