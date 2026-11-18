import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BLOCKS_LOCK_FILE,
  blocksLockOf,
  blocksLockText,
  emptyBlocksLock,
  isBlocksLock,
  readBlocksLock,
  writeBlocksLock,
  type BlocksLock,
} from "../src/blocks/lock.ts";
import type { Block, Page } from "../src/contracts/index.ts";

const LOCK: BlocksLock = {
  version: 1,
  pages: {
    "guide/b.md": { note: 7 },
    "guide/a.md": { intro: 5 },
  },
};

function root(): string {
  return mkdtempSync(join(tmpdir(), "blocks-lock-"));
}

function page(file: string, blocks?: readonly Block[]): Page {
  const at = (line: number) => ({ file, line, column: 1, endLine: line, endColumn: 2 });
  return {
    url: `/${file.replace(/\.md$/, "/")}`,
    source: at(1),
    frontMatter: {},
    title: file,
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "",
    markdown: "",
    kind: "doc",
    ...(blocks === undefined ? {} : { blocks }),
  };
}

test("a missing lock is an empty lock that no check has started from", async () => {
  const dir = root();
  try {
    const read = await readBlocksLock(dir);
    assert.deepEqual(read.lock, emptyBlocksLock());
    assert.equal(read.found, false);
    assert.deepEqual(read.diagnostics, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a malformed lock is an error and yields an empty lock", async () => {
  const dir = root();
  try {
    writeFileSync(join(dir, BLOCKS_LOCK_FILE), "{ not json");
    const read = await readBlocksLock(dir);
    assert.equal(read.found, true);
    assert.deepEqual(read.lock, emptyBlocksLock());
    assert.equal(read.diagnostics[0]?.id, "data.blocks-lock-invalid");
    assert.equal(read.diagnostics[0]?.severity, "error");
    assert.match(read.diagnostics[0]?.message ?? "", /not valid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a lock that breaks the schema is an error and yields an empty lock", async () => {
  const dir = root();
  try {
    for (const value of [
      { version: 2, pages: {} },
      { version: 1, pages: { "guide/a.md": { Bad_Id: 1 } } },
      { version: 1, pages: { "guide/a.md": { intro: 0 } } },
    ]) {
      writeFileSync(join(dir, BLOCKS_LOCK_FILE), JSON.stringify(value));
      const read = await readBlocksLock(dir);
      assert.equal(isBlocksLock(value), false);
      assert.deepEqual(read.lock, emptyBlocksLock());
      assert.equal(read.diagnostics[0]?.id, "data.blocks-lock-invalid");
      assert.match(read.diagnostics[0]?.message ?? "", /blocks\.lock\.schema\.json/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the lock text sorts keys at every level, ends in one LF, and holds no timestamp", async () => {
  const text = blocksLockText(LOCK);
  assert.ok(text.endsWith("\n"));
  assert.equal(text.split("\n").length, 2, "one trailing line feed, not a blank line");
  assert.ok(text.indexOf('"guide/a.md"') < text.indexOf('"guide/b.md"'));
  assert.doesNotMatch(text, /\d{4}-\d\d-\d\dT\d\d:/);
  assert.deepEqual(JSON.parse(text), LOCK);
});

test("a written lock reads back equal", async () => {
  const dir = root();
  try {
    await writeBlocksLock(dir, LOCK);
    const read = await readBlocksLock(dir);
    assert.equal(read.found, true);
    assert.deepEqual(read.diagnostics, []);
    assert.deepEqual(read.lock, LOCK);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the lock of a build holds each page's ids and lines, and omits pages without blocks", () => {
  const at = (line: number) => ({ line, column: 1, endLine: line, endColumn: 2 });
  const lock = blocksLockOf([
    page("guide/b.md", [{ id: "note", pos: { file: "guide/b.md", ...at(9) } }]),
    page("guide/none.md"),
    page("guide/empty.md", []),
    page("guide/a.md", [
      { id: "intro", pos: { file: "guide/a.md", ...at(5) } },
      { id: "b-0123456789", pos: { file: "guide/a.md", ...at(12) } },
    ]),
  ]);
  assert.deepEqual(lock, {
    version: 1,
    pages: {
      "guide/b.md": { note: 9 },
      "guide/a.md": { intro: 5, "b-0123456789": 12 },
    },
  });
});
