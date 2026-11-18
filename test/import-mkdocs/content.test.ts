import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { convertPage } from "../../src/import/mkdocs/content.ts";
import { mkdocsImporter } from "../../src/import/mkdocs/index.ts";
import { readImportSource } from "../../src/import/source.ts";

const FILES = [
  "docs/assets/logo.svg",
  "docs/guide/page.md",
  "docs/index.md",
  "docs/snippets/install.md",
  "mkdocs.yml",
];

/** Converts one page against the fixture's file list. */
function convert(markdown: string, source = "index.md", destination = "index.md") {
  return convertPage(markdown, source, destination, { docsDir: "docs", files: FILES });
}

/** A temporary source tree holding `files`. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "import-mkdocs-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

test("admonitions keep their type, title, initial state, and sample text", () => {
  const page = convert(
    [
      "# Page",
      "",
      '!!! note "Read this"',
      "    The body **stays** Markdown.",
      "",
      '???+ warning "Open first"',
      "    Expanded by default.",
      "",
      '??? tip "Closed"',
      "    Hidden by default.",
      "",
    ].join("\n"),
  );

  assert.equal(
    page.contents,
    [
      "# Page",
      "",
      ':::note{title="Read this"}',
      "The body **stays** Markdown.",
      ":::",
      "",
      ':::warning{title="Open first" collapsible open}',
      "Expanded by default.",
      ":::",
      "",
      ':::tip{title="Closed" collapsible}',
      "Hidden by default.",
      ":::",
      "",
    ].join("\n"),
  );
  assert.deepEqual(
    page.blocks.map((block) => [block.line, block.status]),
    [[3, "full"], [6, "full"], [9, "full"]],
  );
  assert.deepEqual(page.diagnostics, []);
});

test("a nested admonition and a fenced example are not confused with the outer block", () => {
  const page = convert(
    [
      '!!! note "Outer"',
      "    Text.",
      "",
      "    !!! tip",
      "        Inner.",
      "",
      "```md",
      "!!! note",
      "    an example",
      "```",
      "",
    ].join("\n"),
  );

  assert.equal(
    page.contents,
    [
      ':::note{title="Outer"}',
      "Text.",
      "",
      ":::tip",
      "Inner.",
      ":::",
      ":::",
      "",
      "```md",
      "!!! note",
      "    an example",
      "```",
      "",
    ].join("\n"),
  );
});

test("tabs keep each label, its order, and its content", () => {
  const page = convert(
    [
      "=== \"macOS\"",
      "    - Homebrew",
      "    - `brew install orbit`",
      "",
      "=== Linux",
      "    Use the package.",
      "",
    ].join("\n"),
  );

  assert.equal(
    page.contents,
    [
      ":::::tabs",
      ':::tab{label="macOS"}',
      "- Homebrew",
      "- `brew install orbit`",
      ":::",
      ':::tab{label="Linux"}',
      "Use the package.",
      ":::",
      ":::::",
      "",
    ].join("\n"),
  );
});

test("a snippet becomes an include relative to the page, and a line range is kept", () => {
  const page = convert(
    ['--8<-- "snippets/install.md"', '--8<-- "snippets/install.md:2:4"', ""].join("\n"),
    "guide/page.md",
    "guide/page.md",
  );

  assert.equal(
    page.contents,
    ["::include[../snippets/install.md]", "::include[../snippets/install.md]{lines=2-4}", ""].join("\n"),
  );
  assert.deepEqual(page.diagnostics, []);
});

test("a missing snippet and a named fragment each leave a diagnostic at their line", () => {
  const page = convert(['--8<-- "snippets/gone.md"', '--8<-- "snippets/install.md:start:end"', ""].join("\n"));

  assert.deepEqual(
    page.diagnostics.map((finding) => [finding.id, finding.severity, finding.pos?.line]),
    [
      ["import.snippet-missing", "warning", 1],
      ["import.snippet-fragment", "warning", 2],
    ],
  );
  assert.equal(page.contents, ['--8<-- "snippets/gone.md"', '--8<-- "snippets/install.md:start:end"', ""].join("\n"));
  assert.deepEqual(page.blocks, []);
});

test("plugins and theme features without a destination are reported with their line", async () => {
  const root = tree({
    "mkdocs.yml": [
      "site_name: Plugins",
      "plugins:",
      "  - search",
      "  - awesome-pages:",
      "      nav_file: SUMMARY.md",
      "theme:",
      "  features:",
      "    - navigation.tabs",
      "",
    ].join("\n"),
    "docs/index.md": "# Home\n",
  });
  const outcome = await mkdocsImporter.import(readImportSource(root));

  assert.deepEqual(
    outcome.diagnostics.map((finding) => [finding.id, finding.pos?.line, finding.severity]),
    [
      ["import.plugin", 3, "warning"],
      ["import.plugin", 4, "warning"],
      ["import.theme-feature", 8, "warning"],
    ],
  );
  assert.match(outcome.diagnostics[1]?.message ?? "", /awesome-pages/);
  assert.match(outcome.diagnostics[1]?.message ?? "", /no destination equivalent/);
  assert.match(outcome.diagnostics[2]?.message ?? "", /navigation\.tabs/);
});
