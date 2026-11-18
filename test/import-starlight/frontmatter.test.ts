/**
 * Front matter for #753: a page keeps its title and description, and a Starlight draft becomes Mizzen's
 * `published: false`, so the destination build matches the source.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { generateProject } from "../../src/import/generate.ts";
import { buildMappings } from "../../src/import/mapping.ts";
import { readImportSource } from "../../src/import/source.ts";
import { starlightImporter } from "../../src/import/starlight/importer.ts";
import { buildModel } from "../../src/model/build.ts";

/** A temporary source tree holding `files`. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "import-starlight-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** Imports one temporary Starlight site and cleans up after itself. */
async function imported(files: Record<string, string>): Promise<Awaited<ReturnType<typeof starlightImporter.import>>> {
  const root = tree(files);
  try {
    return await starlightImporter.import(readImportSource(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** A config naming `sidebar` when given. */
function config(sidebar?: string): string {
  return `import starlight from "@astrojs/starlight";\n\nexport default {\n  integrations: [\n    starlight({\n      title: "Docs",${sidebar === undefined ? "" : `\n      sidebar: ${sidebar},`}\n    }),\n  ],\n};\n`;
}

const PAGES = {
  "astro.config.mjs": config(),
  "src/content/docs/index.md": "---\ntitle: Home\ndescription: The landing page.\n---\n\n# Home\n",
  "src/content/docs/guide/page.md":
    "---\ntitle: Guide\ndescription: One page.\ndraft: false\ncustom: kept\n---\n\n# Guide\n",
  "src/content/docs/wip.md": "---\ntitle: Work in progress\ndraft: true\n---\n\n# WIP\n",
};

/** Writes the imported pages as a site and builds it. */
async function build(source: ReturnType<typeof readImportSource>, outcome: Awaited<ReturnType<typeof starlightImporter.import>>) {
  const out = mkdtempSync(join(tmpdir(), "import-generated-"));
  try {
    const { mappings, diagnostics } = buildMappings(outcome.files, outcome.pages, outcome.assets, outcome.config);
    assert.deepEqual(diagnostics, []);
    const generated = generateProject({
      source,
      destination: out,
      mappings,
      pages: outcome.pages,
      assets: outcome.assets,
      config: outcome.config,
    });
    assert.deepEqual(generated.diagnostics, []);
    return await buildModel(out);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

test("title and description survive and a draft page is not built", async () => {
  const root = tree(PAGES);
  try {
    const source = readImportSource(root);
    const outcome = await starlightImporter.import(source);
    assert.deepEqual(outcome.diagnostics, []);

    const contents = new Map(outcome.pages.map((page) => [page.source, page.contents]));
    assert.equal(contents.get("src/content/docs/index.md"), "---\ntitle: Home\ndescription: The landing page.\n---\n\n# Home\n");
    assert.equal(
      contents.get("src/content/docs/guide/page.md"),
      "---\ntitle: Guide\ndescription: One page.\ncustom: kept\n---\n\n# Guide\n",
    );
    assert.equal(
      contents.get("src/content/docs/wip.md"),
      "---\ntitle: Work in progress\npublished: false\n---\n\n# WIP\n",
    );

    const { site, diagnostics } = await build(source, outcome);
    assert.deepEqual(
      diagnostics.filter((finding) => finding.severity === "error"),
      [],
    );
    assert.deepEqual(
      site.pages.map((page) => page.url),
      ["/", "/guide/page/"],
      "the draft page has no destination page",
    );
    const guide = site.pages.find((page) => page.url === "/guide/page/");
    assert.equal(guide?.title, "Guide");
    assert.equal(guide?.frontMatter.description, "One page.");
    assert.equal(guide?.frontMatter.custom, "kept");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
