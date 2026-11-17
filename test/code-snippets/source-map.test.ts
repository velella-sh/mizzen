/**
 * Issue #565: a snippet renders as a code block whose language comes from its file or an explicit choice, and whose
 * source map names the real file and lines. The insertion directive's span stays separate from the code's source.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Code, Root } from "mdast";
import { readSourceRange, type SourceSnippet } from "../../src/content/code-snippets/read.ts";
import { markdownToHtml } from "../../src/markdown/to-html.ts";
import { langFromPath, renderSnippet } from "../../src/markdown/plugins/code-snippets.ts";

const SITE = fileURLToPath(new URL("../../fixtures/code-snippets/site", import.meta.url));

/** The fixture file's lines, as they are on disk. */
async function fixtureLines(): Promise<string[]> {
  return (await readFile(join(SITE, "example.ts"), "utf8")).replace(/\n$/, "").split("\n");
}

/** Lines of the fixture read the way a snippet is read. */
async function read(lines?: string): Promise<SourceSnippet> {
  const result = await readSourceRange({
    sourceDir: SITE,
    path: "example.ts",
    ...(lines === undefined ? {} : { lines }),
  });
  assert.deepEqual(result.diagnostics, []);
  assert.ok(result.snippet !== undefined, "the fixture range reads");
  return result.snippet;
}

/** Renders one block as the page body that holds it. */
async function htmlOf(node: Code): Promise<string> {
  const tree: Root = { type: "root", children: [node] };
  return (await markdownToHtml(tree, "guide.md")).html;
}

test("a range becomes a code block whose language and source map follow the file", async () => {
  const snippet = await read("2-4");
  const { node, sourceMap } = renderSnippet({ snippet });
  const fixture = await fixtureLines();

  assert.equal(node.lang, "ts");
  assert.equal(node.value, fixture.slice(1, 4).join("\n"));
  assert.deepEqual(sourceMap, { file: "example.ts", start: 2, end: 4, lines: [2, 3, 4] });

  // The block points at the source, not at the page line the directive sits on, and keeps every byte.
  assert.equal(
    await htmlOf(node),
    `<pre data-src="example.ts:2:1-4:1"><code class="language-ts">${fixture.slice(1, 4).join("\n")}\n</code></pre>`,
  );
});

test("an explicit language wins and the insertion point stays in the page", async () => {
  const snippet = await read("2");
  const pos = { file: "guide.md", line: 7, column: 1, endLine: 7, endColumn: 49 };
  const { node, sourceMap } = renderSnippet({ snippet, lang: "tsx", pos });
  const fixture = await fixtureLines();

  assert.equal(node.lang, "tsx");
  assert.deepEqual(sourceMap.insertion, pos);
  assert.deepEqual(node.position, { start: { line: 7, column: 1 }, end: { line: 7, column: 50 } });

  const html = await htmlOf(node);
  assert.match(html, new RegExp(`^<pre data-src="example\\.ts:2:1-2:${fixture[1]?.length}"><code class="language-tsx">`));
  assert.doesNotMatch(html, /guide\.md/);
});

test("the extension picks the language, and an unknown extension leaves the block unlabelled", () => {
  assert.equal(langFromPath("src/example.ts"), "ts");
  assert.equal(langFromPath("docs/theme.YAML"), "yaml");
  assert.equal(langFromPath("run.sh"), "bash");
  assert.equal(langFromPath("notes.unknown"), "");
  assert.equal(langFromPath("Makefile"), "");
});

test("an empty file makes an empty block with no lines to map", async () => {
  const root = mkdtempSync(join(tmpdir(), "code-snippets-source-map-"));
  try {
    writeFileSync(join(root, "empty.txt"), "");
    const result = await readSourceRange({ sourceDir: root, path: "empty.txt" });
    assert.ok(result.snippet !== undefined);
    const { node, sourceMap } = renderSnippet({ snippet: result.snippet });

    assert.equal(node.value, "");
    assert.deepEqual(sourceMap, { file: "empty.txt", start: 1, end: 0, lines: [] });
    assert.equal(await htmlOf(node), '<pre data-src="empty.txt:1:1-1:1"><code></code></pre>');
  } finally {
    rmSync(root, { recursive: true });
  }
});
