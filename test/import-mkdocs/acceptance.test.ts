import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { generateProject } from "../../src/import/generate.ts";
import { inventoryOf } from "../../src/import/inventory.ts";
import { rewriteLinks } from "../../src/import/links.ts";
import { buildMappings } from "../../src/import/mapping.ts";
import { mkdocsImporter } from "../../src/import/mkdocs/index.ts";
import { readImportSource } from "../../src/import/source.ts";
import { build } from "../../src/pipeline/build.ts";

const FIXTURE = fileURLToPath(new URL("../../fixtures/import-mkdocs/material", import.meta.url));
const THEME = fileURLToPath(new URL("../../../lateen", import.meta.url));

test("a Material site imports its components and builds, and names the plugins that need a person", async () => {
  const parent = mkdtempSync(join(tmpdir(), "import-mkdocs-material-"));
  const generated = join(parent, "project");
  const out = join(parent, "site");
  try {
    const source = readImportSource(FIXTURE);
    const outcome = await mkdocsImporter.import(source);

    const manual = outcome.diagnostics.map((diagnostic) => [diagnostic.id, diagnostic.severity]);
    assert.ok(manual.some(([id]) => id === "import.plugin"), "a plugin is reported");
    assert.ok(manual.some(([id]) => id === "import.theme-feature"), "a theme feature is reported");
    assert.deepEqual(outcome.diagnostics.filter((diagnostic) => diagnostic.severity === "error"), []);

    const { files } = inventoryOf(source.files, outcome.files);
    const { mappings } = buildMappings(files, outcome.pages, outcome.assets, outcome.config);
    const links = rewriteLinks(outcome.pages, mappings);
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

    const result = await build({ root: generated, out, themeRoot: THEME, defaultLayout: "doc" });
    assert.deepEqual(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error"), []);
    assert.deepEqual(result.diagnostics.filter((diagnostic) => diagnostic.id === "link.missing-page"), []);

    const html = readFileSync(join(out, "index.html"), "utf8");
    assert.match(html, /class="callout callout-note"/);
    assert.match(html, /Before you start/);
    assert.match(html, /class="callout callout-warning"/);
    assert.match(html, /Rollback/);
    const labels = [...html.matchAll(/<button\b[^>]*role="tab"[^>]*>([^<]*)<\/button>/g)].map((match) => match[1]);
    assert.deepEqual(labels, ["macOS", "Linux"]);
    assert.match(html, /Install Orbit with the package manager\./);
    assert.match(html, /href="\/guide\/setup\/"/, "the page link reaches the imported page");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
