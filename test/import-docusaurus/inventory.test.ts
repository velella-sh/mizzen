import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { docusaurusImporter } from "../../src/import/docusaurus/index.ts";
import { readImportSource } from "../../src/import/source.ts";

const FIXTURE = fileURLToPath(new URL("../../fixtures/import-docusaurus/two-docs", import.meta.url));

test("the fixture's classic docs and plugin docs both become pages", async () => {
  const outcome = await docusaurusImporter.import(readImportSource(FIXTURE));

  assert.deepEqual(outcome.files.filter((file) => file.kind === "content"), [
    { path: "docs/intro.md", kind: "content" },
    { path: "api-docs/overview.md", kind: "content" },
  ]);
  assert.deepEqual(outcome.files.find((file) => file.path === "static/logo.png"), { path: "static/logo.png", kind: "asset" });
  assert.deepEqual(
    outcome.pages.map((page) => [page.source, page.destination]),
    [
      ["docs/intro.md", "docs/intro.md"],
      ["api-docs/overview.md", "api-docs/overview.md"],
    ],
  );
  assert.match(outcome.pages[0]!.contents, /^---\ntitle: Introduction\n---\n/);
  assert.equal(outcome.config.source, undefined);
  assert.deepEqual(outcome.diagnostics.filter((diagnostic) => diagnostic.severity === "error"), []);
});

test("a source without a Docusaurus config reports where the importer looks", async () => {
  const root = mkdtempSync(join(tmpdir(), "import-docusaurus-"));
  writeFileSync(join(root, "index.md"), "# Home\n");

  const outcome = await docusaurusImporter.import(readImportSource(root));

  assert.deepEqual(
    outcome.diagnostics.map((diagnostic) => [diagnostic.id, diagnostic.severity, diagnostic.pos?.file]),
    [["import.config-missing", "error", "docusaurus.config.js"]],
  );
});
