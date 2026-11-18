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

/** The sorted ids a build recorded, from the lock and from `blocks.json`. */
function recordedIds(root: string, out: string): { lock: Record<string, string[]>; output: string[] } {
  const lock = JSON.parse(readFileSync(join(root, BLOCKS_LOCK_FILE), "utf8")) as {
    pages: Record<string, Record<string, number>>;
  };
  const blocks = JSON.parse(readFileSync(join(out, "blocks.json"), "utf8")) as {
    blocks: Record<string, { file: string }>;
  };
  return {
    lock: Object.fromEntries(Object.entries(lock.pages).map(([file, ids]) => [file, Object.keys(ids).sort()])),
    output: Object.keys(blocks.blocks).sort(),
  };
}

test("a paragraph and a heading edit keep their ids, and a lock without blocks still builds", async () => {
  const parent = mkdtempSync(join(tmpdir(), "model-blocks-keep-"));
  const root = join(parent, "site");
  const folder = join(parent, "out");
  cpSync(FIXTURE, root, { recursive: true });
  const file = join(root, "guide/blocks.md");
  try {
    const first = await build({ root, out: folder, themeRoot: THEME, defaultLayout: "doc", updateBlocks: true });
    assert.deepEqual(first.diagnostics.filter((diagnostic) => diagnostic.severity === "error"), []);
    const before = recordedIds(root, folder);
    assert.ok(before.lock["guide/blocks.md"]!.includes("intro"));
    assert.ok(before.lock["guide/blocks.md"]!.includes("note"));

    const source = readFileSync(file, "utf8");
    writeFileSync(
      file,
      source
        .replace("The heading above declares its own id.", "A changed sentence.")
        .replace("## Automatic", "## Still automatic"),
    );
    const second = await build({ root, out: folder, themeRoot: THEME, defaultLayout: "doc", updateBlocks: true });
    assert.deepEqual(second.diagnostics.filter((diagnostic) => diagnostic.severity === "error"), []);
    assert.deepEqual(recordedIds(root, folder), before, "every id survived the two edits");

    const old = tree({
      "mizzen.yml": "title: Old lock\n",
      "a.md": "---\ntitle: A\n---\n# Title {#intro}\n\nBody.\n",
      [BLOCKS_LOCK_FILE]: '{"version":1,"pages":{"a.md":{"intro":5}}}\n',
    });
    const oldOut = out();
    try {
      const result = await build({ root: old, out: oldOut, themeRoot: THEME, defaultLayout: "doc" });
      assert.deepEqual(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error"), []);
      assert.ok(recordedIds(old, oldOut).output.includes("intro"), "the build read the old lock");
    } finally {
      rmSync(old, { recursive: true, force: true });
      rmSync(oldOut, { recursive: true, force: true });
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a block moved to another page keeps its id, and the lock records the move", async () => {
  const folder = out();
  const root = tree({
    "mizzen.yml": "title: Move\n",
    "a.md": "---\ntitle: A\n---\n# A\n\nStays on A.\n\n<!-- {#mover} -->\nMoves to B.\n",
    "b.md": "---\ntitle: B\n---\n# B\n\nWas already on B.\n",
  });
  const buildWith = () => build({ root, out: folder, themeRoot: THEME, defaultLayout: "doc", updateBlocks: true });
  const lockOf = () =>
    JSON.parse(readFileSync(join(root, BLOCKS_LOCK_FILE), "utf8")) as {
      pages: Record<string, Record<string, number>>;
      moves?: Record<string, { from: string; to: string }>;
    };
  const noErrors = (result: { diagnostics: readonly { severity: string }[] }) =>
    assert.deepEqual(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error"), []);
  try {
    noErrors(await buildWith());
    assert.ok(lockOf().pages["a.md"]!.mover !== undefined);
    assert.equal(lockOf().moves, undefined, "a site with no move has no moves");

    writeFileSync(join(root, "a.md"), "---\ntitle: A\n---\n# A\n\nStays on A.\n");
    writeFileSync(join(root, "b.md"), "---\ntitle: B\n---\n# B\n\nWas already on B.\n\n<!-- {#mover} -->\nMoves to B.\n");
    noErrors(await buildWith());
    assert.ok(lockOf().pages["b.md"]!.mover !== undefined, "the id is unchanged on its new page");
    assert.deepEqual(lockOf().moves, { mover: { from: "a.md", to: "b.md" } });
    const blocks = JSON.parse(readFileSync(join(folder, "blocks.json"), "utf8")) as {
      blocks: Record<string, { file: string }>;
    };
    assert.equal(blocks.blocks.mover!.file, "b.md");

    noErrors(await buildWith());
    assert.deepEqual(lockOf().moves, { mover: { from: "a.md", to: "b.md" } }, "a rebuild without a move keeps it");
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

test("an edited heading keeps its earlier anchor as an alias and in the HTML", async () => {
  const root = tree({
    "mizzen.yml": "title: Aliases\n",
    "a.md": "---\ntitle: A\n---\n# First title\n\nBody.\n",
  });
  const folder = out();
  const lockOf = () =>
    JSON.parse(readFileSync(join(root, BLOCKS_LOCK_FILE), "utf8")) as {
      blocks: Record<string, { anchor?: string; aliases?: string[] }>;
    };
  try {
    const first = await build({ root, out: folder, themeRoot: THEME, defaultLayout: "doc", updateBlocks: true });
    assert.deepEqual(first.diagnostics.filter((diagnostic) => diagnostic.severity === "error"), []);
    const heading = Object.values(lockOf().blocks).find((entry) => entry.anchor === "first-title");
    assert.ok(heading !== undefined, "the heading's anchor is recorded");
    assert.equal(heading.aliases, undefined, "an unchanged heading has no alias");

    writeFileSync(join(root, "a.md"), "---\ntitle: A\n---\n# Second title\n\nBody.\n");
    const second = await build({ root, out: folder, themeRoot: THEME, defaultLayout: "doc", updateBlocks: true });
    assert.deepEqual(second.diagnostics.filter((diagnostic) => diagnostic.severity === "error"), []);
    const edited = Object.values(lockOf().blocks).find((entry) => entry.anchor === "second-title");
    assert.ok(edited !== undefined, "the heading keeps its id and takes the new anchor");
    assert.deepEqual(edited.aliases, ["first-title"], "the earlier anchor is kept as an alias");
    const html = readFileSync(join(folder, "a/index.html"), "utf8");
    assert.ok(html.includes('id="first-title"'), "an old link still lands on the heading");
    assert.ok(html.includes('id="second-title"'), "the new anchor is there too");

    const old = lockOf();
    for (const entry of Object.values(old.blocks)) {
      delete entry.anchor;
      delete entry.aliases;
    }
    writeFileSync(join(root, BLOCKS_LOCK_FILE), `${JSON.stringify(old)}\n`);
    const stripped = await build({ root, out: folder, themeRoot: THEME, defaultLayout: "doc" });
    assert.deepEqual(stripped.diagnostics.filter((diagnostic) => diagnostic.severity === "error"), [], "an old lock without anchors stays valid");
    assert.ok(recordedIds(root, folder).output.length > 0, "the ids still build");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
  }
});

test("a new heading that takes an old alias reports blocks.alias-conflict", async () => {
  const root = tree({
    "mizzen.yml": "title: Alias conflict\n",
    "a.md": "---\ntitle: A\n---\n# First title\n\nBody.\n",
  });
  const folder = out();
  const buildWith = () => build({ root, out: folder, themeRoot: THEME, defaultLayout: "doc", updateBlocks: true });
  const noErrors = (result: { diagnostics: readonly { severity: string }[] }) =>
    assert.deepEqual(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error"), []);
  try {
    noErrors(await buildWith());
    writeFileSync(join(root, "a.md"), "---\ntitle: A\n---\n# Second title\n\nBody.\n");
    noErrors(await buildWith());
    writeFileSync(join(root, "a.md"), "---\ntitle: A\n---\n# Second title\n\nBody.\n\n# First title\n");
    const conflict = await buildWith();
    const finding = conflict.diagnostics.find((diagnostic) => diagnostic.id === "blocks.alias-conflict");
    assert.ok(finding !== undefined, "the old alias and the new heading collide");
    assert.equal(finding.severity, "error");
    assert.ok(finding.message.includes("a.md:4"), finding.message);
    assert.ok(finding.message.includes("a.md:8"), finding.message);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
  }
});
