/** The semantic block diff: matching by id, noise removal, kinds, spans, uncertainty, and filtering. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseChangeType, filterChangeTypes } from "../src/cli/diff.ts";
import { diffBuilds } from "../src/diff/index.ts";
import type { Block } from "../src/diff/types.ts";
import { cleanup, writeBuild, type FixtureBlock } from "./site-diff-builds.ts";

/** One page with explicit block ids and, optionally, page JSON. */
function page(md: string, blocks: readonly FixtureBlock[], json?: unknown) {
  return { url: "/g/", title: "G", source: "g.md", md, blocks, ...(json === undefined ? {} : { json }) };
}

async function compare(before: { md: string; blocks: readonly FixtureBlock[]; json?: unknown }, after: { md: string; blocks: readonly FixtureBlock[]; json?: unknown }) {
  const a = await writeBuild({ pages: [page(before.md, before.blocks, before.json)] });
  const b = await writeBuild({ pages: [page(after.md, after.blocks, after.json)] });
  const diff = await diffBuilds(a, b);
  cleanup(a, b);
  return diff;
}

/** A block with a declared id: `<!-- {#id} -->` above `text`, at `line`. */
function block(id: string, line: number, endLine = line + 1): FixtureBlock {
  return { id, line, endLine };
}

test("a block is matched by its id, so a heading edit stays the same block", async () => {
  const before = "# G {#g}\n\n## One {#one}\n\nalpha\n";
  const after = "# G {#g}\n\n## Un {#one}\n\nalpha\n";
  const diff = await compare({ md: before, blocks: [block("g", 1), block("one", 3, 5)] }, { md: after, blocks: [block("g", 1), block("one", 3, 5)] });
  const blocks = diff.pages.changed[0]!.blocks;
  assert.deepEqual(blocks.map((change) => change.kind), ["heading"]);
  assert.deepEqual(blocks[0]!.text, { before: "One", after: "Un" });
  assert.equal(blocks[0]!.id, "one");
});

test("a whitespace change and shifted lines report no semantic change", async () => {
  const before = "# G {#g}\n\n## One {#one}\n\nalpha\n";
  const after = "# G {#g}\n\n\n\n## One {#one}\n\nalpha   \n";
  const diff = await compare({ md: before, blocks: [block("g", 1), block("one", 3, 5)] }, { md: after, blocks: [block("g", 1), block("one", 5, 7)] });
  assert.deepEqual(diff.pages.changed[0]!.blocks, []);
  assert.equal(diff.identical, false);
});

test("a plain move and a move with a content change are distinguishable", async () => {
  const before = "<!-- {#a} -->\nalpha\n\n<!-- {#b} -->\nbeta\n";
  const moved = "<!-- {#b} -->\nbeta\n\n<!-- {#a} -->\nalpha\n";
  const edited = "<!-- {#b} -->\nbeta two\n\n<!-- {#a} -->\nalpha\n";
  const plain = await compare({ md: before, blocks: [block("a", 2), block("b", 5)] }, { md: moved, blocks: [block("b", 2), block("a", 5)] });
  assert.ok(plain.pages.changed[0]!.blocks.every((change) => change.kind === "moved"));
  const changed = await compare({ md: before, blocks: [block("a", 2), block("b", 5)] }, { md: edited, blocks: [block("b", 2), block("a", 5)] });
  assert.ok(changed.pages.changed[0]!.blocks.some((change) => change.kind === "edited" || change.kind === "moved-edited"));
});

test("a table is compared by cells and the changed cell is reported", async () => {
  const before = "<!-- {#t} -->\n| a | b |\n|---|---|\n| 1 | 2 |\n";
  const after = "<!-- {#t} -->\n| a | b |\n|---|---|\n| 1 | 3 |\n";
  const diff = await compare({ md: before, blocks: [block("t", 2, 4)] }, { md: after, blocks: [block("t", 2, 4)] });
  const change = diff.pages.changed[0]!.blocks.find((entry) => entry.kind === "table")!;
  assert.deepEqual(change.cell, { row: 2, column: 2 });
  assert.deepEqual(change.text, { before: "2", after: "3" });
});

test("a destination change is visible when the label and alt stay the same", async () => {
  const before = "<!-- {#l} -->\n[label](/one)\n\n<!-- {#i} -->\n![alt](/one.png)\n";
  const after = "<!-- {#l} -->\n[label](/two)\n\n<!-- {#i} -->\n![alt](/two.png)\n";
  const diff = await compare({ md: before, blocks: [block("l", 2), block("i", 5)] }, { md: after, blocks: [block("l", 2), block("i", 5)] });
  const blocks = diff.pages.changed[0]!.blocks;
  assert.deepEqual(blocks.find((entry) => entry.kind === "link")!.destination, { before: "/one", after: "/two" });
  assert.deepEqual(blocks.find((entry) => entry.kind === "image")!.destination, { before: "/one.png", after: "/two.png" });
});

test("code, a language change, and a heading each get their own kind", async () => {
  const before = "# G {#g}\n\n<!-- {#c} -->\n```js\none\n```\n";
  const after = "# G {#g}\n\n<!-- {#c} -->\n```ts\none\n```\n";
  const language = await compare({ md: before, blocks: [block("g", 1), block("c", 4, 6)] }, { md: after, blocks: [block("g", 1), block("c", 4, 6)] });
  const change = language.pages.changed[0]!.blocks.find((entry) => entry.kind === "code-language")!;
  assert.deepEqual(change.language, { before: "js", after: "ts" });

  const bodyBefore = "<!-- {#c} -->\n```js\none\n```\n";
  const bodyAfter = "<!-- {#c} -->\n```js\ntwo\n```\n";
  const code = await compare({ md: bodyBefore, blocks: [block("c", 2, 4)] }, { md: bodyAfter, blocks: [block("c", 2, 4)] });
  assert.equal(code.pages.changed[0]!.blocks[0]!.kind, "code");
});

test("a changed value produced from a record shows the field and both values", async () => {
  const before = "<!-- {#s} -->\nStatus: draft\n";
  const after = "<!-- {#s} -->\nStatus: live\n";
  const diff = await compare(
    { md: before, blocks: [block("s", 2)], json: { record: { fields: { status: "draft" } } } },
    { md: after, blocks: [block("s", 2)], json: { record: { fields: { status: "live" } } } },
  );
  const change = diff.pages.changed[0]!.blocks.find((entry) => entry.kind === "record")!;
  assert.equal(change.field, "status");
  assert.deepEqual(change.value, { before: "draft", after: "live" });
});

test("both sides of a change carry their source span", async () => {
  const before = "# G {#g}\n\n## One {#one}\n\n<!-- {#p} -->\nalpha\n";
  const after = "# G {#g}\n\n## One {#one}\n\n<!-- {#p} -->\nbeta\n";
  const diff = await compare({ md: before, blocks: [block("g", 1), block("one", 3), block("p", 6, 7)] }, { md: after, blocks: [block("g", 1), block("one", 3), block("p", 6, 7)] });
  const change = diff.pages.changed[0]!.blocks.find((entry) => entry.kind === "edited")!;
  assert.deepEqual(change.before, { path: "g.md", range: { start: 6, end: 7 } });
  assert.deepEqual(change.after, { path: "g.md", range: { start: 6, end: 7 } });
});

test("two ambiguous blocks are uncertain, never matched with false certainty", async () => {
  const before = "<!-- {#dup} -->\nalpha\n\n<!-- {#dup} -->\nbeta\n";
  const after = "<!-- {#dup} -->\ngamma\n";
  const diff = await compare({ md: before, blocks: [block("dup", 2), block("dup", 5)] }, { md: after, blocks: [block("dup", 2)] });
  const blocks = diff.pages.changed[0]!.blocks;
  assert.ok(blocks.some((entry) => entry.kind === "uncertain"));
  assert.ok(blocks.every((entry) => entry.kind !== "moved" && entry.kind !== "edited"));
});

test("the report has a schema version and the change-type filter keeps only that type", async () => {
  const before = "<!-- {#l} -->\n[label](/one)\n\n<!-- {#t} -->\n| a |\n|---|\n| 1 |\n";
  const after = "<!-- {#l} -->\n[label](/two)\n\n<!-- {#t} -->\n| a |\n|---|\n| 2 |\n";
  const diff = await compare({ md: before, blocks: [block("l", 2), block("t", 5, 7)] }, { md: after, blocks: [block("l", 2), block("t", 5, 7)] });
  assert.equal(diff.schemaVersion, 1);
  const filtered = filterChangeTypes(diff, ["link"]);
  const blocks: Block[] = [...filtered.pages.changed[0]!.blocks];
  assert.ok(blocks.length > 0);
  assert.ok(blocks.every((entry) => entry.kind === "link"));
  assert.deepEqual(parseChangeType("heading,link"), ["heading", "link"]);
  assert.equal(typeof parseChangeType("nope"), "string");
});

test("a build without block ids still uses the heading diff", async () => {
  const a = await writeBuild({ pages: [{ url: "/g/", title: "G", md: "# G\n\n## One\n\nalpha\n" }] });
  const b = await writeBuild({ pages: [{ url: "/g/", title: "G", md: "# G\n\n## One\n\nbeta\n" }] });
  const diff = await diffBuilds(a, b);
  cleanup(a, b);
  assert.deepEqual(diff.pages.changed[0]!.blocks.map((entry) => entry.kind), ["edited"]);
  assert.equal(diff.schemaVersion, 1);
});
