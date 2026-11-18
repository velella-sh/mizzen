import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Diagnostic } from "../../src/contracts/index.ts";
import { readImportSource } from "../../src/import/source.ts";
import { vitepressImporter } from "../../src/import/vitepress/importer.ts";

/** A temporary source tree holding `files`. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "import-vitepress-frontmatter-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** The converted contents of one page in a one-page site. */
async function convertedPage(page: string): Promise<{ contents: string | undefined; diagnostics: Awaited<ReturnType<typeof vitepressImporter.import>>["diagnostics"] }> {
  const root = tree({ ".vitepress/config.mjs": "export default { srcDir: 'docs' };\n", "docs/page.md": page });
  try {
    const outcome = await vitepressImporter.import(readImportSource(root));
    return { contents: outcome.pages.find((entry) => entry.source === "docs/page.md")?.contents, diagnostics: outcome.diagnostics };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("title and description keep their keys and draft becomes the publication state", async () => {
  const { contents, diagnostics } = await convertedPage(
    "---\ntitle: Deploy\ndescription: How to deploy.\ndraft: true\n---\n# Deploy\n",
  );

  assert.equal(contents, "---\ntitle: Deploy\ndescription: How to deploy.\npublished: false\n---\n# Deploy\n");
  assert.deepEqual(diagnostics, []);
});

test("draft false publishes the page, and a page without front matter is byte for byte the same", async () => {
  assert.equal((await convertedPage("---\ndraft: false\n---\n# Page\n")).contents, "---\npublished: true\n---\n# Page\n");
  assert.equal((await convertedPage("# Page\n")).contents, "# Page\n");
});

test("a setting with no equivalent is commented at its line and reported once", async () => {
  const { contents, diagnostics } = await convertedPage(
    "---\ntitle: Home\nsidebar: false\nhead:\n  - - meta\n    - name: description\n---\n# Home\n",
  );

  assert.equal(
    contents,
    "---\ntitle: Home\n#sidebar: false\n#head:\n#  - - meta\n#    - name: description\n---\n# Home\n",
  );
  assert.deepEqual(
    diagnostics.map((finding) => [finding.id, finding.severity, finding.pos?.line]),
    [
      ["import.front-matter", "warning", 3],
      ["import.front-matter", "warning", 4],
    ],
  );
  assert.match(diagnostics[0]?.message ?? "", /sidebar/);
  assert.match(diagnostics[1]?.message ?? "", /head/);
});

test("an unclosed front matter block is left for the engine to report", async () => {
  const page = "---\ntitle: Page\n# Page\n";
  const { contents, diagnostics } = await convertedPage(page);
  assert.equal(contents, page);
  assert.deepEqual(diagnostics, []);
});
