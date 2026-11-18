import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { mkdocsImporter } from "../../src/import/mkdocs/index.ts";
import { readImportSource } from "../../src/import/source.ts";

const FIXTURE = fileURLToPath(new URL("../../fixtures/import-mkdocs/basic", import.meta.url));

test("mkdocs reads the pages and assets under docs_dir", async () => {
  const outcome = await mkdocsImporter.import(readImportSource(FIXTURE));
  const page = outcome.pages.find((entry) => entry.source === "content/guide/page.md");
  assert.equal(page?.destination, "guide/page.md");
  assert.equal(page?.contents, "# Guide\n\nA page.\n");
  assert.equal(outcome.pages.find((entry) => entry.source === "content/index.md")?.destination, "index.md");
  assert.deepEqual(
    outcome.assets.map((asset) => [asset.source, asset.destination]),
    [["content/assets/logo.png", "assets/logo.png"]],
  );
  assert.equal(outcome.files.find((file) => file.path === "README.md")?.kind, "unsupported");
  assert.ok(!outcome.pages.some((entry) => entry.source === "README.md"));
  assert.deepEqual(outcome.diagnostics, []);
  assert.equal(outcome.config.source, "mkdocs.yml");
  assert.equal(outcome.config.contents, "title: Basic\n");
});

test("mkdocs reports a docs_dir that names no folder", async () => {
  const root = mkdtempSync(join(tmpdir(), "import-mkdocs-"));
  mkdirSync(join(root, "content"));
  writeFileSync(join(root, "mkdocs.yml"), "site_name: Broken\ndocs_dir: missing\n");
  const outcome = await mkdocsImporter.import(readImportSource(root));
  assert.deepEqual(
    outcome.diagnostics.map((entry) => [entry.id, entry.severity, entry.pos?.file, entry.pos?.line]),
    [["import.docs-dir", "error", "mkdocs.yml", 2]],
  );
  assert.deepEqual(outcome.pages, []);
});
