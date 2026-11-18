import assert from "node:assert/strict";
import { test } from "node:test";
import { blocksOf } from "../src/blocks/parse.ts";
import { parseMarkdown } from "../src/markdown/parse.ts";

const file = "guide/blocks.md";
const bodyLine = 5;

async function assign(markdown: string) {
  const tree = await parseMarkdown(markdown, bodyLine);
  return blocksOf({ file, tree, markdown, bodyLine });
}

test("a heading's {#id} names its block, and a marker names the block after it", async () => {
  const result = await assign(
    "## Intro {#intro}\n\n<!-- {#note} -->\n\nSome *text*.\n\n## Next\n",
  );
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.blocks.length, 3);
  assert.deepEqual(result.blocks.slice(0, 2).map((block) => block.id), ["intro", "note"]);
  assert.match(result.blocks[2]?.id ?? "", /^b-[0-9a-f]{10}$/);
});

test("an invalid declared id is an error, and the block falls back to an automatic id", async () => {
  const result = await assign("## Intro {#Not_Valid}\n");
  assert.equal(result.blocks.length, 1);
  assert.match(result.blocks[0]?.id ?? "", /^b-[0-9a-f]{10}$/);
  const [diagnostic] = result.diagnostics;
  assert.equal(diagnostic?.id, "blocks.invalid-id");
  assert.equal(diagnostic?.severity, "error");
  assert.equal(diagnostic?.pos?.file, file);
  assert.equal(diagnostic?.pos?.line, bodyLine);
  assert.match(diagnostic?.message ?? "", /"Not_Valid"/);
});

test("a marker with no block after it is an error", async () => {
  const result = await assign("Some text.\n\n<!-- {#orphan} -->\n");
  assert.equal(result.blocks.length, 1);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.id, "blocks.marker-unused");
  assert.equal(result.diagnostics[0]?.pos?.line, bodyLine + 2);
});

test("a link reference definition is not a block", async () => {
  const result = await assign("Some text.\n\n[ref]: https://example.test\n\nMore text.\n");
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.blocks.length, 2);
});

test("an automatic id depends only on the page and the block's Markdown", async () => {
  const first = await assign("Some *text*.\n");
  const second = await assign("Some *text*.\n");
  const moved = await assign("Intro.\n\nSome *text*.\n");
  assert.match(first.blocks[0]?.id ?? "", /^b-[0-9a-f]{10}$/);
  assert.equal(first.blocks[0]?.id, second.blocks[0]?.id);
  assert.equal(first.blocks[0]?.id, moved.blocks[1]?.id);
});

test("positions are lines of the full file, offset by the front matter", async () => {
  const result = await assign("Some text.\n\n## Intro {#intro}\n");
  assert.deepEqual(result.blocks.map((block) => block.pos.line), [bodyLine, bodyLine + 2]);
  assert.equal(result.blocks[1]?.pos.column, 1);
  assert.equal(result.blocks[1]?.pos.file, file);
});
