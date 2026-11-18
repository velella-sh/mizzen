import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { docusaurusImporter } from "../../src/import/docusaurus/index.ts";
import { readImportSource } from "../../src/import/source.ts";

const FIXTURE = fileURLToPath(new URL("../../fixtures/import-docusaurus/two-docs", import.meta.url));

/** A temporary Docusaurus source: one docs folder and the given files. */
function site(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "import-docusaurus-"));
  const all = { "docusaurus.config.js": "module.exports = { presets: [['classic', { docs: { path: 'docs' } }]] };\n", ...files };
  for (const [path, text] of Object.entries(all)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

test("a manual sidebar becomes main navigation with labels, categories, and external links", async () => {
  const outcome = await docusaurusImporter.import(readImportSource(FIXTURE));
  assert.ok(outcome.navigation);
  assert.equal(outcome.navigation.source, "sidebars.js");
  assert.deepEqual(parse(outcome.navigation.contents), {
    main: [
      { title: "Introduction", url: "/docs/intro/" },
      { title: "API", children: [{ title: "API overview", url: "/api-docs/overview/" }] },
      { title: "Guides", url: "https://example.com/guides" },
    ],
  });
  assert.deepEqual(outcome.diagnostics.filter((diagnostic) => diagnostic.severity === "error"), []);
  assert.deepEqual(outcome.files.find((file) => file.path === "sidebars.js")?.kind, "unsupported");
});

test("an explicit slug becomes a permalink and the page's URL is the slug", async () => {
  const root = site({
    "docs/install.md": "---\ntitle: Install\ndescription: How to install.\nslug: /getting-started/install/\n---\n# Install\n",
    "docs/plain.md": "---\ntitle: Plain\n---\n# Plain\n",
  });
  try {
    const outcome = await docusaurusImporter.import(readImportSource(root));
    const page = outcome.pages.find((entry) => entry.source === "docs/install.md");
    assert.equal(page?.contents, "---\ntitle: Install\ndescription: How to install.\npermalink: \"/getting-started/install/\"\n---\n# Install\n");
    assert.equal(outcome.pages.find((entry) => entry.source === "docs/plain.md")?.contents, "---\ntitle: Plain\n---\n# Plain\n");
    assert.deepEqual(outcome.diagnostics, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("two pages that a slug would serve at one URL are reported", async () => {
  const root = site({
    "docs/one.md": "---\nslug: /shared/\n---\n# One\n",
    "docs/two.md": "---\nslug: /shared\n---\n# Two\n",
  });
  try {
    const outcome = await docusaurusImporter.import(readImportSource(root));
    assert.deepEqual(
      outcome.diagnostics.map((diagnostic) => [diagnostic.id, diagnostic.severity]),
      [["import.duplicate-url", "error"]],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
