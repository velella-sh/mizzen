import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { mkdocsImporter } from "../../src/import/mkdocs/index.ts";
import { readImportSource } from "../../src/import/source.ts";
import { parse } from "yaml";

const FIXTURE = fileURLToPath(new URL("../../fixtures/import-mkdocs/basic", import.meta.url));
const FILES = fileURLToPath(new URL("../../fixtures/import-mkdocs/files", import.meta.url));

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

test("mkdocs keeps the nav order, nested groups, and external links", async () => {
  const outcome = await mkdocsImporter.import(readImportSource(FIXTURE));
  assert.ok(outcome.navigation);
  assert.equal(outcome.navigation.source, "mkdocs.yml");
  assert.deepEqual(parse(outcome.navigation.contents), {
    main: [
      { title: "Home", url: "/" },
      { title: "Guide", children: [{ title: "Guide", url: "/guide/page/" }] },
      { title: "External", url: "https://example.com/" },
    ],
  });
});

test("use_directory_urls false maps pages and nav links to .html URLs", async () => {
  const outcome = await mkdocsImporter.import(readImportSource(FILES));
  assert.equal(outcome.urls, "files");
  assert.ok(outcome.navigation);
  assert.deepEqual(parse(outcome.navigation.contents), {
    main: [
      { title: "Home", url: "/index.html" },
      { title: "Other", url: "/guide/page.html" },
    ],
  });
});
