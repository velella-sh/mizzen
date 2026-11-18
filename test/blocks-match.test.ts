import assert from "node:assert/strict";
import { test } from "node:test";
import type { BlocksLock, RecordedBlock } from "../src/blocks/lock.ts";
import { matchBlockIds, type MatchPage } from "../src/blocks/match.ts";
import type { Block } from "../src/contracts/index.ts";

/** A lock whose pages hold `[id, fingerprint]` in source order, one line each. */
function lockOf(pages: Record<string, readonly (readonly [string, string])[]>): BlocksLock {
  const locked: Record<string, Record<string, number>> = {};
  const blocks: Record<string, RecordedBlock> = {};
  for (const [file, entries] of Object.entries(pages)) {
    const lines: Record<string, number> = {};
    for (const [index, [id, fingerprint]] of entries.entries()) {
      lines[id] = index + 1;
      blocks[id] = { file, fingerprint };
    }
    locked[file] = lines;
  }
  return { version: 1, pages: locked, blocks };
}

/** A block of `file` whose source hashes to `fingerprint`; `id` is what {@link blocksOf} would have given it. */
function block(file: string, id: string, fingerprint: string, options: { readonly declared?: boolean } = {}): Block {
  return {
    id,
    pos: { file, line: 1, column: 1, endLine: 1, endColumn: 2 },
    fingerprint,
    ...(options.declared === true ? { declared: true } : {}),
  };
}

/** One page as the build stages it. */
function page(file: string, blocks: readonly Block[]): MatchPage {
  return { file, blocks };
}

/** The ids the match gave one page. */
function ids(matched: Map<string, readonly Block[]>, file: string): string[] {
  return (matched.get(file) ?? []).map((block) => block.id);
}

test("reordering a page's blocks keeps each id", () => {
  const previous = lockOf({
    "a.md": [["one", "first text"], ["two", "second text"], ["three", "third text"]],
  });
  const matched = matchBlockIds(previous, [
    page("a.md", [
      block("a.md", "b-3333333333", "third text"),
      block("a.md", "b-1111111111", "first text"),
      block("a.md", "b-2222222222", "second text"),
    ]),
  ]);
  assert.deepEqual(ids(matched, "a.md"), ["three", "one", "two"]);
});

test("an edit that keeps the block count keeps the block's id", () => {
  const previous = lockOf({
    "a.md": [["one", "first text"], ["two", "second text"], ["three", "third text"]],
  });
  const matched = matchBlockIds(previous, [
    page("a.md", [
      block("a.md", "b-1111111111", "first text"),
      block("a.md", "b-9999999999", "second text, now edited"),
      block("a.md", "b-3333333333", "third text"),
    ]),
  ]);
  assert.deepEqual(ids(matched, "a.md"), ["one", "two", "three"]);
});

test("editing a heading's text keeps its id", () => {
  const previous = lockOf({
    "a.md": [["install", "## Install"], ["usage", "Run the tool."]],
  });
  const matched = matchBlockIds(previous, [
    page("a.md", [
      block("a.md", "b-1111111111", "## Setup"),
      block("a.md", "b-2222222222", "Run the tool."),
    ]),
  ]);
  assert.deepEqual(ids(matched, "a.md"), ["install", "usage"]);
});

test("a block moved to another page keeps its id", () => {
  const previous = lockOf({
    "a.md": [["keep", "stays here"], ["mover", "moves away"]],
    "b.md": [["host", "was already here"]],
  });
  const matched = matchBlockIds(previous, [
    page("a.md", [block("a.md", "b-1111111111", "stays here")]),
    page("b.md", [
      block("b.md", "b-2222222222", "was already here"),
      block("b.md", "b-3333333333", "moves away"),
    ]),
  ]);
  assert.deepEqual(ids(matched, "a.md"), ["keep"]);
  assert.deepEqual(ids(matched, "b.md"), ["host", "mover"]);
});

test("a declared id is never handed to another block", () => {
  const previous = lockOf({
    "a.md": [["mine", "old text"], ["kept", "kept text"]],
  });
  const matched = matchBlockIds(previous, [
    page("a.md", [
      block("a.md", "mine", "new text", { declared: true }),
      block("a.md", "b-1111111111", "old text"),
      block("a.md", "b-2222222222", "other text"),
    ]),
  ]);
  assert.deepEqual(ids(matched, "a.md"), ["mine", "b-1111111111", "b-2222222222"]);
});

test("no recorded id is used twice across the site", () => {
  const previous = lockOf({
    "a.md": [["one", "same text"], ["two", "same text"]],
    "b.md": [["three", "same text"]],
  });
  const matched = matchBlockIds(previous, [
    page("a.md", [block("a.md", "b-4444444444", "same text"), block("a.md", "b-5555555555", "same text")]),
    page("b.md", [block("b.md", "b-6666666666", "same text")]),
  ]);
  assert.deepEqual(ids(matched, "a.md"), ["one", "two"], "each page takes its own recorded ids first");
  assert.deepEqual(ids(matched, "b.md"), ["three"]);
  const all = [...ids(matched, "a.md"), ...ids(matched, "b.md")];
  assert.equal(new Set(all).size, all.length);
});

test("an unequal block count with no matching content gets no guessed id", () => {
  const previous = lockOf({
    "a.md": [["one", "old one"], ["two", "old two"], ["three", "old three"]],
  });
  const matched = matchBlockIds(previous, [
    page("a.md", [block("a.md", "b-1111111111", "new one"), block("a.md", "b-2222222222", "new two")]),
    page("b.md", [block("b.md", "b-3333333333", "never recorded")]),
  ]);
  assert.deepEqual(ids(matched, "a.md"), ["b-1111111111", "b-2222222222"]);
  assert.deepEqual(ids(matched, "b.md"), ["b-3333333333"]);
});
