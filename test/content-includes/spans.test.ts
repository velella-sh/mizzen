import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { Diagnostic, SourcePos } from "../../src/contracts/index.ts";
import { sourceSpanOf } from "../../src/content/include-spans.ts";
import { expandIncludes, type ExpandIncludesOptions, type IncludeResult } from "../../src/content/includes.ts";
import { buildModel } from "../../src/model/build.ts";

/** A temporary folder holding `files`; the caller removes it. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "include-spans-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** Expands `body` of `file` under `root`, with the defaults the engine's build uses. */
function expand(root: string, file: string, body: string, extra: Partial<ExpandIncludesOptions> = {}) {
  return expandIncludes({ body, bodyLine: 1, file, sourceDir: root, ...extra });
}

/** The exact source span of one expanded-body range; `end` is exclusive. */
function span(result: IncludeResult, startLine: number, startColumn: number, endLine: number, endColumn: number): SourcePos {
  const found = sourceSpanOf(
    result.spans,
    { line: startLine, column: startColumn },
    { line: endLine, column: endColumn },
  );
  assert.ok(found !== undefined, `no span for ${startLine}:${startColumn}-${endLine}:${endColumn}`);
  return found;
}

/** The one finding with `id` in `file`, so a test can assert its position. */
function finding(diagnostics: readonly Diagnostic[], id: string, file: string): Diagnostic & { readonly pos: SourcePos } {
  const found = diagnostics.filter((diagnostic) => diagnostic.id === id && diagnostic.pos?.file === file);
  assert.equal(found.length, 1, `expected one ${id} in ${file}`);
  return found[0] as Diagnostic & { readonly pos: SourcePos };
}

test("the page's own lines keep their positions around an include", async () => {
  const root = tree({ "_snippets/note.md": "Fragment line.\n" });
  try {
    const result = await expand(root, "guide/page.md", "Page line.\n\n::include[../_snippets/note.md]\nAfter.\n", { bodyLine: 5 });
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(span(result, 5, 1, 5, 11), { file: "guide/page.md", line: 5, column: 1, endLine: 5, endColumn: 10 });
    assert.deepEqual(span(result, 7, 1, 7, 15), { file: "_snippets/note.md", line: 1, column: 1, endLine: 1, endColumn: 14 });
    assert.deepEqual(span(result, 8, 1, 8, 7), { file: "guide/page.md", line: 8, column: 1, endLine: 8, endColumn: 6 });
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("a fragment heading keeps the fragment and the value keeps its placeholder span", async () => {
  const root = tree({
    "_snippets/nested.md": "> Nested\n",
    "_snippets/frag.md": "---\nparams:\n  product: Beacon\n---\n## Install {{product}}\n::include[nested.md]\nTail\n",
  });
  try {
    const result = await expand(root, "guide/page.md", "# Page\n::include[../_snippets/frag.md]{product=\"Orbit\"}\nAfter\n", {
      bodyLine: 4,
    });
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.body, "# Page\n## Install Orbit\n> Nested\nTail\nAfter\n");
    assert.deepEqual(span(result, 4, 1, 4, 7), { file: "guide/page.md", line: 4, column: 1, endLine: 4, endColumn: 6 });
    assert.deepEqual(span(result, 5, 1, 5, 17), {
      file: "_snippets/frag.md",
      line: 5,
      column: 1,
      endLine: 5,
      endColumn: 22,
    });
    assert.deepEqual(span(result, 6, 1, 6, 9), {
      file: "_snippets/nested.md",
      line: 1,
      column: 1,
      endLine: 1,
      endColumn: 8,
    });
    assert.deepEqual(span(result, 7, 1, 7, 5), { file: "_snippets/frag.md", line: 7, column: 1, endLine: 7, endColumn: 4 });
    assert.deepEqual(span(result, 8, 1, 8, 6), { file: "guide/page.md", line: 6, column: 1, endLine: 6, endColumn: 5 });
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("a lines range names the original line in the fragment", async () => {
  const root = tree({
    "_snippets/sliced.md": "---\ntitle: Sliced\n---\nzero\none\ntwo\n",
  });
  try {
    const result = await expand(root, "page.md", "::include[_snippets/sliced.md]{lines=2-3}\n");
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.body, "one\ntwo\n");
    assert.deepEqual(span(result, 1, 1, 1, 4), {
      file: "_snippets/sliced.md",
      line: 5,
      column: 1,
      endLine: 5,
      endColumn: 3,
    });
    assert.deepEqual(span(result, 2, 1, 2, 4), {
      file: "_snippets/sliced.md",
      line: 6,
      column: 1,
      endLine: 6,
      endColumn: 3,
    });
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("a parameter error points at the call site, and a nested one at the fragment that calls it", async () => {
  const root = tree({
    "_snippets/inner.md": "---\nparams:\n  name:\n---\nHello {{name}}\n",
    "_snippets/outer.md": "---\nparams:\n  who:\n---\n::include[inner.md]\n",
  });
  try {
    const result = await expand(root, "page.md", "Intro\n\n::include[_snippets/outer.md]\n");
    assert.equal(result.diagnostics.length, 2);
    assert.deepEqual(finding(result.diagnostics, "include.param-missing", "page.md").pos, {
      file: "page.md",
      line: 3,
      column: 1,
      endLine: 3,
      endColumn: 29,
    });
    assert.deepEqual(finding(result.diagnostics, "include.param-missing", "_snippets/outer.md").pos, {
      file: "_snippets/outer.md",
      line: 5,
      column: 1,
      endLine: 5,
      endColumn: 19,
    });
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("the model keeps a fragment heading and data-src on the fragment's file and line", async () => {
  const root = tree({
    "mizzen.yml": "title: T\n",
    "_snippets/nested.md": "> Nested\n",
    "_snippets/frag.md": "---\nparams:\n  product: Beacon\n---\n## Install {{product}}\n::include[nested.md]\nTail\n",
    "guide/page.md": "---\ntitle: Page\n---\n# Page\n::include[../_snippets/frag.md]{product=\"Orbit\"}\nAfter\n",
  });
  try {
    const { site, diagnostics } = await buildModel(root);
    assert.deepEqual(diagnostics.filter((diagnostic) => diagnostic.severity === "error"), []);
    const page = site.pages.find((entry) => entry.url === "/guide/page/");
    assert.ok(page !== undefined);
    assert.deepEqual(page.headings.map((heading) => heading.pos), [
      { file: "guide/page.md", line: 4, column: 1, endLine: 4, endColumn: 6 },
      { file: "_snippets/frag.md", line: 5, column: 1, endLine: 5, endColumn: 22 },
    ]);
    assert.match(page.html, /data-src="_snippets\/frag\.md:5:1-5:22"/);
    assert.match(page.html, /data-src="_snippets\/nested\.md:1:1-1:8"/);
  } finally {
    rmSync(root, { recursive: true });
  }
});
