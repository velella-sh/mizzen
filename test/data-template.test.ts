import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config/load.ts";
import { discover } from "../src/content/discover.ts";
import { loadTemplates } from "../src/data/template.ts";
import { copyAssets } from "../src/pipeline/assets.ts";

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "data-template-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const SITE = {
  "mizzen.yml":
    "collections:\n" +
    "  components:\n" +
    "    source: _data/components.yml\n" +
    "    template: _templates/components.md\n" +
    "  releases:\n" +
    "    source: _data/releases.yml\n",
  "_templates/components.md": "---\nlayout: record\n---\n# {field:name}\n\nBody.\n",
};

test("a declared template keeps its front matter, body, and starting line", async () => {
  const root = tree(SITE);
  try {
    const { config } = loadConfig(root);
    const result = await loadTemplates({ root, config });
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(Object.keys(result.templates), ["components"]);
    const template = result.templates["components"]!;
    assert.equal(template.collection, "components");
    assert.equal(template.path, "_templates/components.md");
    assert.deepEqual(template.frontMatter, { layout: "record" });
    assert.equal(template.body, "# {field:name}\n\nBody.\n");
    assert.equal(template.bodyLine, 4);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("templates are discovered as their own kind and never copied as assets", async () => {
  const root = tree({
    ...SITE,
    "_data/components.yml": "- id: button\n",
    "_data/releases.yml": "- id: 1\n",
    "logo.png": "\u0089PNG\r\n\u001a\n",
  });
  const out = mkdtempSync(join(tmpdir(), "data-template-out-"));
  try {
    const files = await discover(root);
    assert.deepEqual(
      files.map((file) => [file.path, file.kind]),
      [
        ["_data/components.yml", "data"],
        ["_data/releases.yml", "data"],
        ["_templates/components.md", "template"],
        ["logo.png", "asset"],
        ["mizzen.yml", "asset"],
      ],
    );
    const copied = await copyAssets({ source: root, out, files });
    assert.deepEqual(copied.files.map((file) => file.path), ["logo.png", "mizzen.yml"]);
  } finally {
    rmSync(root, { recursive: true });
    rmSync(out, { recursive: true });
  }
});

test("a missing template is an error at its config line, and the collection has no template", async () => {
  const root = tree(SITE);
  try {
    rmSync(join(root, "_templates/components.md"));
    const { config } = loadConfig(root);
    const result = await loadTemplates({ root, config });
    assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.id), ["data.template-missing"]);
    const finding = result.diagnostics[0]!;
    assert.equal(finding.severity, "error");
    assert.match(finding.message, /_templates\/components\.md/);
    assert.deepEqual(finding.pos, { file: "mizzen.yml", line: 4, column: 15, endLine: 4, endColumn: 38 });
    assert.deepEqual(result.templates, {});
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("a template that cannot be read is an error, not a rejected promise", async () => {
  const root = tree(SITE);
  try {
    rmSync(join(root, "_templates/components.md"));
    mkdirSync(join(root, "_templates/components.md"), { recursive: true });
    const { config } = loadConfig(root);
    const result = await loadTemplates({ root, config });
    assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.id), ["data.template-unreadable"]);
    assert.equal(result.diagnostics[0]!.severity, "error");
    assert.deepEqual(result.templates, {});
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("a template outside _templates or outside the source folder is refused at the config line", async () => {
  for (const template of ["components.md", "../secret.md", "_templates/../../secret.md", "_templates/../components.md"]) {
    const root = tree({
      ...SITE,
      "mizzen.yml":
        "collections:\n" +
        "  components:\n" +
        "    source: _data/components.yml\n" +
        `    template: ${template}\n`,
    });
    try {
      const { config } = loadConfig(root);
      const result = await loadTemplates({ root, config });
      assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.id), ["data.template-path"], template);
      assert.equal(result.diagnostics[0]!.pos?.line, 4, template);
      assert.deepEqual(result.templates, {});
    } finally {
      rmSync(root, { recursive: true });
    }
  }
});

test("a relative source folder resolves templates against it, with paths from the site root", async () => {
  const root = tree({
    "mizzen.yml": "source: docs\ncollections:\n  items:\n    source: _data/items.yml\n    template: _templates/items.md\n",
    "docs/_templates/items.md": "---\nlayout: entry\n---\nBody.\n",
  });
  try {
    const { config } = loadConfig(root);
    const result = await loadTemplates({ root, config });
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.templates["items"]!.path, "docs/_templates/items.md");
  } finally {
    rmSync(root, { recursive: true });
  }
});
