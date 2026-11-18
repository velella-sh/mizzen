import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { generateProject } from "../../src/import/generate.ts";
import { inventoryOf } from "../../src/import/inventory.ts";
import { rewriteLinks } from "../../src/import/links.ts";
import { buildMappings } from "../../src/import/mapping.ts";
import { readImportSource } from "../../src/import/source.ts";
import { vitepressImporter } from "../../src/import/vitepress/importer.ts";
import { build } from "../../src/pipeline/build.ts";

const FIXTURE = fileURLToPath(new URL("../../fixtures/import-vitepress/subpath", import.meta.url));
const THEME = fileURLToPath(new URL("../../../lateen", import.meta.url));

test("a site under a subpath imports with base-aware links, rewrites, locales, and public assets that build", async () => {
  const parent = mkdtempSync(join(tmpdir(), "import-vitepress-subpath-"));
  const generated = join(parent, "project");
  const out = join(parent, "site");
  try {
    const source = readImportSource(FIXTURE);
    const outcome = await vitepressImporter.import(source);
    assert.deepEqual(outcome.diagnostics, []);
    assert.equal(outcome.base, "/beacon");
    assert.equal(outcome.contentRoot, "docs/");

    const { files } = inventoryOf(source.files, outcome.files);
    const { mappings, diagnostics } = buildMappings(files, outcome.pages, outcome.assets, outcome.config, outcome.urls, outcome.base);
    assert.deepEqual(diagnostics, []);
    const links = rewriteLinks(outcome.pages, mappings, { base: outcome.base, contentRoot: outcome.contentRoot });
    const written = generateProject({
      source,
      destination: generated,
      mappings,
      pages: links.pages,
      assets: outcome.assets,
      config: outcome.config,
      ...(outcome.navigation === undefined ? {} : { navigation: outcome.navigation }),
    });
    assert.deepEqual(written.diagnostics.filter((diagnostic) => diagnostic.severity === "error"), []);

    // `base`, the locale, and the rewrite reach the generated project.
    const config = readFileSync(join(generated, "mizzen.yml"), "utf8");
    assert.match(config, /base: "\/beacon"/);
    assert.match(config, /languages:/);
    assert.ok(existsSync(join(generated, "handbook/page.md")), "the rewrite moves the page");
    assert.ok(existsSync(join(generated, "fa/index.md")), "the translated page keeps its prefix");
    assert.ok(existsSync(join(generated, "logo.svg")), "a public file lands at the site root");

    // An internal link becomes the page's destination URL, base included.
    assert.match(readFileSync(join(generated, "index.md"), "utf8"), /\(\/beacon\/handbook\/page\/\)/);
    const navigation = readFileSync(join(generated, "_data/navigation.yml"), "utf8");
    assert.match(navigation, /^main:/m);
    assert.match(navigation, /^docs:/m);
    assert.match(navigation, /^main_fa:/m);

    const result = await build({ root: generated, out, themeRoot: THEME, defaultLayout: "doc" });
    assert.deepEqual(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error"), []);
    assert.deepEqual(result.diagnostics.filter((diagnostic) => diagnostic.id === "link.missing-page"), []);
    const handbook = readFileSync(join(out, "handbook/page/index.html"), "utf8");
    assert.match(handbook, /href="\/beacon\/"/, "the back link reaches the home page under the base");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
