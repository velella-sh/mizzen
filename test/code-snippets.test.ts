/**
 * Issue #563: the baseline for code snippets. `::include` already resolves a source path, a 1-based line range, and
 * the source folder boundary; this test pins what it does with a real source file so the epic can reuse those parts
 * and add the language and source position that the include does not carry.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildModel } from "../src/model/build.ts";
import { buildDependencyGraph, fileNodeId } from "../src/pipeline/dependency-graph.ts";

const SITE = fileURLToPath(new URL("../fixtures/code-snippets/site", import.meta.url));

test("an include splices source lines as page Markdown, without a fence or a language", async () => {
  const { site, diagnostics } = await buildModel(SITE);
  assert.deepEqual(diagnostics, []);
  const page = site.pages.find((candidate) => candidate.url === "/guide/")!;
  assert.match(page.markdown, /export function add\(a: number, b: number\): number \{/);
  assert.doesNotMatch(page.markdown, /```/);
  // Bare source lines are paragraphs: no <pre>, and the block's position is the page's line, not example.ts.
  assert.doesNotMatch(page.html, /<pre/);
  assert.match(page.html, /data-src="guide\.md:7:/);
  assert.doesNotMatch(page.html, /data-src="example\.ts:/);
});

test("a fence cannot wrap an include, so the insertion point cannot set a language", async () => {
  const { site } = await buildModel(SITE);
  const page = site.pages.find((candidate) => candidate.url === "/fenced/")!;
  assert.match(page.html, /<code class="language-ts">::include\[example\.ts\]\{lines=2-4\}/);
  assert.doesNotMatch(page.html, /export function add/);
});

test("the dependency graph already tracks the included source file", async () => {
  const { site } = await buildModel(SITE);
  const { graph } = await buildDependencyGraph({ root: SITE, site });
  const edge = graph.edges.find(
    (candidate) => candidate.from === fileNodeId("guide.md") && candidate.to === fileNodeId("example.ts"),
  );
  assert.ok(edge !== undefined, "guide.md must depend on example.ts");
});
