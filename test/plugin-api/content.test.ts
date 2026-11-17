import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Plugin, SourcePos } from "../../src/contracts/index.ts";
import { buildModel } from "../../src/model/build.ts";

/** A site folder holding the given pages; the caller removes it when the test ends. */
function siteRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "plugin-content-"));
  writeFileSync(join(root, "mizzen.yml"), "title: Plugins\n");
  for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
  return root;
}

test("a validate finding keeps the page's exact source position", async () => {
  const root = siteRoot({ "index.md": "---\ntitle: Install\n---\n\nBody.\n" });
  const plugin: Plugin = {
    name: "needs-summary",
    validate: (page) => [
      { id: "site.missing-summary", severity: "warning", message: "The page has no summary.", pos: page.source },
    ],
  };
  try {
    const { site, diagnostics } = await buildModel(root, { plugins: [plugin] });
    const [page] = site.pages;
    assert.ok(page);
    const expected: SourcePos = { file: "index.md", line: 4, column: 1, endLine: 4, endColumn: 1 };
    assert.deepEqual(page.source, expected, "the page starts after its front matter");
    const finding = diagnostics.find((d) => d.id === "site.missing-summary");
    assert.ok(finding, "the validator's finding reaches the build");
    assert.deepEqual(finding.pos, expected, "the finding keeps the page source position verbatim");
    assert.equal(diagnostics.filter((d) => d.id === "plugin.hook-failed").length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a markdown transform is parsed, and headings keep their line positions", async () => {
  const root = siteRoot({ "index.md": "# Start\n\nBody.\n" });
  const seen: { path: string; markdown: string }[] = [];
  const plugin: Plugin = {
    name: "section",
    markdown: (source) => {
      seen.push({ path: source.path, markdown: source.markdown });
      return source.markdown.replace("Body.", "## Section");
    },
  };
  try {
    const { site, diagnostics } = await buildModel(root, { plugins: [plugin] });
    const [page] = site.pages;
    assert.ok(page);
    assert.deepEqual(diagnostics.filter((d) => d.severity === "error"), []);
    assert.deepEqual(seen, [{ path: "index.md", markdown: "# Start\n\nBody.\n" }]);
    assert.equal(page.markdown, "# Start\n\n## Section\n", "the transformed body is the page's Markdown");
    assert.ok(page.html.includes(">Section</h2>"), page.html);
    assert.deepEqual(
      page.headings.map((heading) => ({ depth: heading.depth, text: heading.text, line: heading.pos.line })),
      [
        { depth: 1, text: "Start", line: 1 },
        { depth: 2, text: "Section", line: 3 },
      ],
      "headings parsed from the transformed body keep their source lines",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a markdown transform that changes the line count is a hook failure and the original is parsed", async () => {
  const root = siteRoot({ "index.md": "# Start\n\nBody.\n" });
  const plugin: Plugin = {
    name: "grower",
    markdown: () => "# Start\n\nBody.\n\nExtra.\n",
  };
  try {
    const { site, diagnostics } = await buildModel(root, { plugins: [plugin] });
    const [page] = site.pages;
    assert.ok(page);
    assert.equal(page.markdown, "# Start\n\nBody.\n", "the text before the failed transform is kept");
    assert.ok(page.html.includes("Body."), page.html);
    assert.ok(!page.html.includes("Extra."), page.html);
    const [failure] = diagnostics.filter((d) => d.id === "plugin.hook-failed");
    assert.ok(failure, "the changed line count is reported");
    assert.ok(failure.message.includes(`"grower"`), failure.message);
    assert.ok(failure.message.includes("markdown hook"), failure.message);
    assert.ok(failure.message.includes("different line count"), failure.message);
    assert.deepEqual(failure.pos, page.source);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
