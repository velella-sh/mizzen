import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readImportSource } from "../../src/import/source.ts";
import { vitepressImporter } from "../../src/import/vitepress/importer.ts";

const FIXTURE = fileURLToPath(new URL("../../fixtures/import-vitepress/site/", import.meta.url));

/** A temporary source tree holding `files`. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "import-vitepress-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

test("the fixture site's pages and assets come from srcDir", async () => {
  const outcome = await vitepressImporter.import(readImportSource(FIXTURE));

  assert.deepEqual(
    outcome.pages.map((page) => [page.source, page.destination]),
    [
      ["docs/guide/page.md", "guide/page.md"],
      ["docs/index.md", "index.md"],
    ],
  );
  assert.deepEqual(outcome.assets, [{ source: "docs/public/logo.svg", destination: "public/logo.svg" }]);
  assert.deepEqual(
    outcome.files.map((file) => file.path),
    [".vitepress/config.mjs", "docs/guide/page.md", "docs/index.md", "docs/public/logo.svg"],
  );
  assert.deepEqual(outcome.diagnostics, []);
  assert.deepEqual(outcome.config, { source: ".vitepress/config.mjs", contents: 'title: "VitePress site"\n' });
});

test("a srcDir outside the source folder is one error", async () => {
  const root = tree({
    ".vitepress/config.mjs": 'export default { srcDir: "../outside", title: "Site" };\n',
    "index.md": "# Home\n",
  });
  try {
    const outcome = await vitepressImporter.import(readImportSource(root));
    assert.equal(outcome.diagnostics.length, 1);
    assert.equal(outcome.diagnostics[0]?.id, "import.src-dir");
    assert.equal(outcome.diagnostics[0]?.severity, "error");
    assert.deepEqual(outcome.pages, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing config is one error", async () => {
  const root = tree({ "index.md": "# Home\n" });
  try {
    const outcome = await vitepressImporter.import(readImportSource(root));
    assert.equal(outcome.diagnostics.length, 1);
    assert.equal(outcome.diagnostics[0]?.id, "import.config-missing");
    assert.equal(outcome.diagnostics[0]?.severity, "error");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
