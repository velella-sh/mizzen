import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { buildModel } from "../src/model/build.ts";

/** A temporary folder holding `files`. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "block-ids-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

test("a duplicate block id in one page names both lines", async () => {
  const root = tree({
    "mizzen.yml": "title: Dups\n",
    "one.md": "---\ntitle: One\n---\n# A {#intro}\n\n# B {#intro}\n",
  });
  try {
    const { site, diagnostics } = await buildModel(root, { updateBlocks: true });
    const [first, second] = site.pages.find((page) => page.source.file === "one.md")!.blocks!;
    const [duplicate, ...rest] = diagnostics;
    assert.equal(rest.length, 0);
    assert.equal(duplicate?.id, "blocks.duplicate-id");
    assert.equal(duplicate?.severity, "error");
    assert.equal(duplicate?.pos?.file, "one.md");
    assert.equal(duplicate?.pos?.line, second?.pos.line);
    const message = duplicate?.message ?? "";
    assert.ok(message.includes(`one.md:${first?.pos.line}`), message);
    assert.ok(message.includes(`one.md:${second?.pos.line}`), message);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a duplicate block id across two pages names both files and lines", async () => {
  const root = tree({
    "mizzen.yml": "title: Dups\n",
    "one.md": "---\ntitle: One\n---\n# A {#shared}\n",
    "two.md": "---\ntitle: Two\n---\n# B {#shared}\n",
  });
  try {
    const { site, diagnostics } = await buildModel(root, { updateBlocks: true });
    const first = site.pages.find((page) => page.source.file === "one.md")!.blocks![0]!;
    const second = site.pages.find((page) => page.source.file === "two.md")!.blocks![0]!;
    const [duplicate, ...rest] = diagnostics;
    assert.equal(rest.length, 0);
    assert.equal(duplicate?.id, "blocks.duplicate-id");
    assert.equal(duplicate?.pos?.file, "two.md");
    assert.equal(duplicate?.pos?.line, second.pos.line);
    const message = duplicate?.message ?? "";
    assert.ok(message.includes(`one.md:${first.pos.line}`), message);
    assert.ok(message.includes(`two.md:${second.pos.line}`), message);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a unique set of block ids is clean", async () => {
  const root = tree({
    "mizzen.yml": "title: Unique\n",
    "one.md": "---\ntitle: One\n---\n# A {#intro}\n",
    "two.md": "---\ntitle: Two\n---\n# B {#outro}\n",
  });
  try {
    const { site, diagnostics } = await buildModel(root, { updateBlocks: true });
    assert.deepEqual(diagnostics, []);
    const ids = site.pages.flatMap((page) => (page.blocks ?? []).map((block) => block.id));
    assert.deepEqual(ids, ["intro", "outro"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
