/**
 * Inventory for #752: a Starlight site's content root comes from `srcDir`, pages and assets are relative to that root,
 * and nothing outside it enters the file list.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readImportSource } from "../../src/import/source.ts";
import { starlightImporter } from "../../src/import/starlight/importer.ts";

const FIXTURE = fileURLToPath(new URL("../../fixtures/import-starlight/site/", import.meta.url));

/** The paths the importer classified as `kind`, in its order. */
function paths(outcome: Awaited<ReturnType<typeof starlightImporter.import>>, kind: string): string[] {
  return outcome.files.filter((file) => file.kind === kind).map((file) => file.path);
}

test("a Starlight site inventories its content root from srcDir", async () => {
  const outcome = await starlightImporter.import(readImportSource(FIXTURE));

  assert.deepEqual(paths(outcome, "content"), [
    "src/content/docs/guide/page.md",
    "src/content/docs/index.md",
  ]);
  assert.deepEqual(paths(outcome, "asset"), ["src/content/docs/logo.png"]);
  assert.deepEqual(paths(outcome, "config"), ["astro.config.mjs"]);
  assert.deepEqual(
    outcome.pages.map((page) => page.destination),
    ["guide/page.md", "index.md"],
  );
  assert.deepEqual(
    outcome.assets.map((asset) => asset.destination),
    ["logo.png"],
  );
  assert.ok(!outcome.files.some((file) => file.path === "outside.md" || file.path === "src/other.md"));
  assert.deepEqual(outcome.config, { source: "astro.config.mjs", contents: "title: Starlight site\n" });
  assert.deepEqual(outcome.diagnostics, []);
});

test("a site without a content root reports where the config is", async () => {
  const root = mkdtempSync(join(tmpdir(), "import-starlight-"));
  try {
    writeFileSync(
      join(root, "astro.config.mjs"),
      'import starlight from "@astrojs/starlight";\nexport default { integrations: [starlight({ title: "T" })] };\n',
    );
    const outcome = await starlightImporter.import(readImportSource(root));
    assert.deepEqual(
      outcome.diagnostics.map((diagnostic) => [diagnostic.id, diagnostic.pos?.file]),
      [["import.content-root", "astro.config.mjs"]],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a site without an Astro config reports it", async () => {
  const root = mkdtempSync(join(tmpdir(), "import-starlight-"));
  try {
    writeFileSync(join(root, "index.md"), "# Home\n");
    const outcome = await starlightImporter.import(readImportSource(root));
    assert.deepEqual(
      outcome.diagnostics.map((diagnostic) => diagnostic.id),
      ["import.config-missing"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
