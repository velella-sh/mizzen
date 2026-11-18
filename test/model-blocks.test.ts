import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BLOCKS_LOCK_FILE } from "../src/blocks/lock.ts";
import { buildModel } from "../src/model/build.ts";
import { build } from "../src/pipeline/build.ts";

const FIXTURE = fileURLToPath(new URL("../fixtures/blocks-site", import.meta.url));
const THEME = fileURLToPath(new URL("../../lateen", import.meta.url));

/** A temporary folder holding `files`. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "model-blocks-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** A scratch folder for the output. */
function out(): string {
  return join(mkdtempSync(join(tmpdir(), "model-blocks-out-")), "site");
}

test("without a lock the model has no blocks and the build writes no blocks.json", async () => {
  const { site, diagnostics } = await buildModel(FIXTURE);
  assert.deepEqual(diagnostics, []);
  assert.ok(site.pages.length > 0);
  assert.ok(site.pages.every((page) => page.blocks === undefined), "no page carries blocks");
  assert.equal(existsSync(join(FIXTURE, BLOCKS_LOCK_FILE)), false);

  const folder = out();
  try {
    const result = await build({ root: FIXTURE, out: folder, themeRoot: THEME, defaultLayout: "doc" });
    assert.deepEqual(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error"), []);
    assert.equal(existsSync(join(folder, "blocks.json")), false);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("updateBlocks fills the model's blocks and writes the lock", async () => {
  const parent = mkdtempSync(join(tmpdir(), "model-blocks-update-"));
  const root = join(parent, "site");
  const folder = join(parent, "out");
  cpSync(FIXTURE, root, { recursive: true });
  try {
    const result = await build({ root, out: folder, themeRoot: THEME, defaultLayout: "doc", updateBlocks: true });
    assert.deepEqual(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error"), []);

    const lock = JSON.parse(readFileSync(join(root, BLOCKS_LOCK_FILE), "utf8")) as {
      version: number;
      pages: Record<string, Record<string, number>>;
    };
    assert.equal(lock.version, 1);
    const ids = lock.pages["guide/blocks.md"]!;
    assert.equal(ids.intro, 5);
    assert.equal(ids.note, 10);
    assert.equal(Object.keys(ids).length, 5, "every top-level block has an id");

    const blocks = JSON.parse(readFileSync(join(folder, "blocks.json"), "utf8")) as {
      blocks: Record<string, { file: string; line: number; url: string }>;
    };
    assert.deepEqual(blocks.blocks.intro, { file: "guide/blocks.md", line: 5, url: "/guide/blocks/" });

    const modeled = await buildModel(root);
    const page = modeled.site.pages.find((candidate) => candidate.source.file === "guide/blocks.md")!;
    assert.ok(page.blocks?.some((block) => block.id === "intro"));
    assert.ok(page.blocks?.some((block) => block.id === "note"));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a build with an error does not write the lock", async () => {
  const root = tree({
    "mizzen.yml": "title: Broken\n",
    "bad.md": "---\ntitle: Bad\n---\n# Bad {#Not_Valid}\n",
  });
  const folder = out();
  try {
    const result = await build({ root, out: folder, themeRoot: THEME, defaultLayout: "doc", updateBlocks: true });
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.id === "blocks.invalid-id"));
    assert.equal(existsSync(join(root, BLOCKS_LOCK_FILE)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
  }
});

test("a list page two has no blocks, and no id repeats across the site", async () => {
  const root = tree({
    "mizzen.yml":
      "title: Lists\n" +
      "collections:\n" +
      "  posts:\n" +
      "    source: _data/posts.yml\n" +
      "    template: _templates/posts.md\n" +
      "    permalink: /posts/{id}/\n",
    "_data/posts.yml": "- id: a\n  title: Alpha\n- id: b\n  title: Beta\n",
    "_templates/posts.md": "---\ntitle: \"{title}\"\n---\n# :field[title]\n",
    "blog/index.md":
      "---\ntitle: Blog\nlist:\n  collection: posts\n  perPage: 1\n---\n# Blog\n\nAll posts.\n",
  });
  try {
    const { site, diagnostics } = await buildModel(root, { updateBlocks: true });
    assert.deepEqual(diagnostics, []);
    const first = site.pages.find((page) => page.url === "/blog/")!;
    const second = site.pages.find((page) => page.url === "/blog/page/2/")!;
    assert.ok((first.blocks?.length ?? 0) > 0, "the declaring page keeps its blocks");
    assert.equal(second.blocks, undefined, "a generated page inherits no blocks");

    const all = site.pages.flatMap((page) => (page.blocks ?? []).map((block) => block.id));
    assert.equal(new Set(all).size, all.length, "no block id is used twice");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
