/**
 * Acceptance for #567: a code block comes from a real file and line range. Editing one line of the source changes
 * the Markdown a reader copies and the rendered HTML, while the block still names the same source range and every
 * rendered line keeps its original 1-based number. The sample is a plain range, with no annotation meta.
 */
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Root } from "mdast";
import { readSourceRange } from "../../src/content/code-snippets/read.ts";
import { markdownToHtml } from "../../src/markdown/to-html.ts";
import { renderSnippet } from "../../src/markdown/plugins/code-snippets.ts";

const SITE = fileURLToPath(new URL("../../fixtures/code-snippets/site/", import.meta.url));

/** Reads lines 2-4 of `example.ts` under `sourceDir`, renders them, and returns both outputs. */
async function render(sourceDir: string) {
  const result = await readSourceRange({ sourceDir, path: "example.ts", lines: "2-4" });
  assert.deepEqual(result.diagnostics, []);
  assert.ok(result.snippet !== undefined, "the fixture range reads");
  const { node, sourceMap } = renderSnippet({ snippet: result.snippet });
  const tree: Root = { type: "root", children: [node] };
  return { markdown: node.value, html: (await markdownToHtml(tree, "guide.md")).html, sourceMap };
}

test("an edited source line changes the Markdown and HTML and keeps the source range", async () => {
  const sourceDir = mkdtempSync(join(tmpdir(), "code-snippets-acceptance-"));
  try {
    cpSync(SITE, sourceDir, { recursive: true });
    const before = await render(sourceDir);
    assert.match(before.markdown, /^export function add\(a: number, b: number\): number \{\n {2}return a \+ b;\n\}$/);

    const lines = readFileSync(join(sourceDir, "example.ts"), "utf8").replace(/\n$/, "").split("\n");
    const edited = lines.slice();
    edited[2] = "  return a + b; // exact";
    writeFileSync(join(sourceDir, "example.ts"), `${edited.join("\n")}\n`);

    const after = await render(sourceDir);
    assert.equal(after.markdown, edited.slice(1, 4).join("\n"));
    assert.equal(
      after.html,
      `<pre data-src="example.ts:2:1-4:${edited[3]!.length}"><code class="language-ts">${edited.slice(1, 4).join("\n")}\n</code></pre>`,
    );
    assert.doesNotMatch(before.html, /\/\/ exact/);
    assert.match(after.html, /return a \+ b; \/\/ exact/);

    // The source range is the same; only the edited line's end column moved with its text.
    assert.equal(after.sourceMap.file, "example.ts");
    assert.deepEqual([after.sourceMap.start, after.sourceMap.end], [2, 4]);
    assert.deepEqual(after.sourceMap.lines, [2, 3, 4]);
  } finally {
    rmSync(sourceDir, { recursive: true, force: true });
  }
});
