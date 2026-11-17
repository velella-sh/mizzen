import assert from "node:assert/strict";
import { test } from "node:test";
import { reportVue } from "../../src/import/vitepress/diagnostics.ts";

/**
 * Issue #585: a VitePress page with Vue logic keeps its static text and links and reports every
 * dynamic part with its source position. Nothing is evaluated.
 */

const FILE = "docs/deploy.md";

test("an unmapped component is unwrapped and reported once", () => {
  const source = [
    "## Release notes",
    "",
    '<ReleaseNotes :version="version">',
    "Read the [release notes](./releases.md) for the version you run.",
    "</ReleaseNotes>",
    "",
  ].join("\n");

  const { markdown, diagnostics } = reportVue(source, FILE);

  assert.equal(
    markdown,
    "## Release notes\n\nRead the [release notes](./releases.md) for the version you run.\n",
  );
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.id, "import.vue-component");
  assert.equal(diagnostics[0]?.severity, "warning");
  assert.match(diagnostics[0]?.message ?? "", /ReleaseNotes/);
  assert.deepEqual(diagnostics[0]?.pos, {
    file: FILE,
    line: 3,
    column: 1,
    endLine: 3,
    endColumn: 33,
  });
});

test("an interpolation and a binding leave their text, and code spans stay code", () => {
  const source = [
    "Version {{ version }} is live.",
    "",
    '<a :href="url">Read the docs</a>.',
    "",
    "Use `{{ literal }}` as text.",
    "",
  ].join("\n");

  const { markdown, diagnostics } = reportVue(source, FILE);

  assert.equal(markdown, "Version  is live.\n\nRead the docs.\n\nUse `{{ literal }}` as text.\n");
  assert.equal(diagnostics.length, 2);
  assert.deepEqual(
    diagnostics.map((finding) => finding.id),
    ["import.vue-expression", "import.vue-expression"],
  );
  assert.deepEqual(diagnostics[0]?.pos, {
    file: FILE,
    line: 1,
    column: 9,
    endLine: 1,
    endColumn: 21,
  });
  assert.match(diagnostics[0]?.message ?? "", /\{\{ version \}\}/);
  assert.deepEqual(diagnostics[1]?.pos, {
    file: FILE,
    line: 3,
    column: 1,
    endLine: 3,
    endColumn: 15,
  });
  assert.match(diagnostics[1]?.message ?? "", /:href/);
  assert.match(diagnostics[1]?.message ?? "", /<a>/);
});

test("a script block is removed unread while the page text stays", () => {
  const source = [
    "# Page",
    "",
    "<script setup>",
    'import { ref } from "vue";',
    "const version = ref('2');",
    "</script>",
    "",
    "Text after.",
    "",
  ].join("\n");

  const { markdown, diagnostics } = reportVue(source, FILE);

  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.id, "import.vue-script");
  assert.deepEqual(diagnostics[0]?.pos, {
    file: FILE,
    line: 3,
    column: 1,
    endLine: 6,
    endColumn: 9,
  });
  assert.equal(markdown.includes("<script"), false);
  assert.equal(markdown.includes("ref("), false);
  assert.equal(markdown.endsWith("Text after.\n"), true);
});

test("Vue syntax in a fenced block is an example and stays byte for byte", () => {
  const source = [
    "```md",
    '<ReleaseNotes :version="version">',
    "{{ version }}",
    "</ReleaseNotes>",
    "```",
    "",
  ].join("\n");

  const { markdown, diagnostics } = reportVue(source, FILE);

  assert.equal(markdown, source);
  assert.deepEqual(diagnostics, []);
});

test("a page without Vue is unchanged and the result is deterministic", () => {
  const source = "# Page\n\nA [link](./other.md) and `code`.\n";

  const first = reportVue(source, FILE);
  const second = reportVue(source, FILE);

  assert.deepEqual(first, second);
  assert.equal(first.markdown, source);
  assert.deepEqual(first.diagnostics, []);
});
