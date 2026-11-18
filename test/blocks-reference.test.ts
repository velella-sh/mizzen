/**
 * Stored machine references: validation, resolution after a URL change or a block move, removal vs unknown, the MCP
 * block input, the pack's versioned reference, a batch check, and the three paths after a second build.
 */
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { isBlockReference, referenceProblem, resolveReference } from "../src/blocks/reference.ts";
import { readBlocksLock } from "../src/blocks/lock.ts";
import { main } from "../src/cli/index.ts";
import { buildModel } from "../src/model/build.ts";
import { version } from "../src/index.ts";
import { build } from "../src/pipeline/build.ts";
import { harness } from "./mcp-helpers.ts";

const FIXTURE = fileURLToPath(new URL("../fixtures/blocks-site", import.meta.url));
const THEME = fileURLToPath(new URL("../../lateen", import.meta.url));

/** A temporary folder holding `files`. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "blocks-reference-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** A scratch copy of the block fixture with a lock written by its first build. */
async function locked(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "blocks-reference-site-"));
  cpSync(FIXTURE, root, { recursive: true });
  await build({ root, out: join(root, "..", "out"), themeRoot: THEME, defaultLayout: "doc", updateBlocks: true });
  rmSync(join(root, "..", "out"), { recursive: true, force: true });
  return root;
}

/** The model and lock a site builds now. */
async function state(root: string) {
  const { site } = await buildModel(root);
  const { lock } = await readBlocksLock(root);
  return { lock, pages: site.pages };
}

test("a reference is validated against its page, block, and format version", () => {
  const reference = { version: 1 as const, page: "guide/blocks.md", block: "note", build: "0.2.4" };
  assert.equal(referenceProblem(reference), undefined);
  assert.equal(isBlockReference(reference), true);
  assert.match(referenceProblem({ version: 2, page: "a.md", block: "note" }) ?? "", /version/);
  assert.match(referenceProblem({ version: 1, page: "", block: "note" }) ?? "", /page/);
  assert.match(referenceProblem({ version: 1, page: "a.md", block: "not a block" }) ?? "", /block/);
  assert.match(referenceProblem({ version: 1, page: "a.md", block: "note", build: "" }) ?? "", /build/);
  assert.equal(isBlockReference(null), false);
});

test("an old reference reaches the page's current URL after its permalink changes", async () => {
  const root = tree({
    "mizzen.yml": "title: Reference\n",
    "guide/install.md": "---\ntitle: Install\n---\n\n# Install {#install}\n\nRun the installer.\n",
  });
  try {
    await build({ root, out: join(root, "..", "out"), themeRoot: THEME, defaultLayout: "doc", updateBlocks: true });
    let now = await state(root);
    const reference = { version: 1 as const, page: "guide/install.md", block: "install" };
    assert.deepEqual(resolveReference(reference, now), {
      status: "resolved",
      reference,
      url: "/guide/install/",
      source: "guide/install.md",
    });

    writeFileSync(join(root, "guide/install.md"), "---\ntitle: Install\npermalink: /setup/\n---\n\n# Install {#install}\n\nRun the installer.\n");
    await build({ root, out: join(root, "..", "out"), themeRoot: THEME, defaultLayout: "doc" });
    now = await state(root);
    assert.equal(resolveReference(reference, now).url, "/setup/");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a reference follows a block that moved to another page", async () => {
  const root = tree({
    "mizzen.yml": "title: Reference\n",
    "one.md": "# One\n\n<!-- {#mover} -->\nMoving text.\n",
    "two.md": "# Two\n\nStill here.\n",
  });
  try {
    await build({ root, out: join(root, "..", "out"), themeRoot: THEME, defaultLayout: "doc", updateBlocks: true });
    const reference = { version: 1 as const, page: "one.md", block: "mover" };
    writeFileSync(join(root, "one.md"), "# One\n\nStill here.\n");
    writeFileSync(join(root, "two.md"), "# Two\n\n<!-- {#mover} -->\nMoving text.\n");
    await build({ root, out: join(root, "..", "out"), themeRoot: THEME, defaultLayout: "doc", updateBlocks: true });
    const now = await state(root);
    const resolution = resolveReference(reference, now);
    assert.equal(resolution.status, "resolved");
    assert.equal(resolution.url, "/two/");
    assert.equal(resolution.source, "two.md");
    assert.equal(resolution.moved, true);
    assert.equal(now.lock.moves?.mover?.to, "two.md");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a recorded removal is not an unknown identifier", async () => {
  const root = tree({
    "mizzen.yml": "title: Reference\n",
    "index.md": "# Home\n\n<!-- {#gone} -->\nRemove me.\n",
  });
  try {
    await build({ root, out: join(root, "..", "out"), themeRoot: THEME, defaultLayout: "doc", updateBlocks: true });
    writeFileSync(join(root, "index.md"), "# Home\n");
    await build({ root, out: join(root, "..", "out"), themeRoot: THEME, defaultLayout: "doc" });
    const now = await state(root);
    assert.equal(resolveReference({ version: 1, page: "index.md", block: "gone" }, now).status, "removed");
    assert.equal(resolveReference({ version: 1, page: "index.md", block: "b-0000000000" }, now).status, "unknown");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("get_block_source accepts a stable block id and keeps the old heading and text inputs", async () => {
  const root = await locked();
  const h = await harness(root);
  try {
    const byBlock = await h.call("get_block_source", { page: "/guide/blocks/", block: "note" });
    assert.equal(byBlock.data.status, "found");
    assert.equal(byBlock.data.block, "note");
    assert.match(byBlock.data.text, /A paragraph with a marker/);
    const byHeading = await h.call("get_block_source", { page: "/guide/blocks/", heading: "intro" });
    assert.equal(byHeading.data.status, "found");
    assert.equal(byHeading.data.block, "intro");
    const byText = await h.call("get_block_source", { page: "/guide/blocks/", text: "A paragraph with a marker" });
    assert.equal(byText.data.status, "found");
    assert.equal(byText.data.block, "note");
    const unknown = await h.call("get_block_source", { page: "/guide/blocks/", block: "b-0000000000" });
    assert.equal(unknown.data.code, "unknown-block");
  } finally {
    await h.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a pack section carries a versioned reference that resolves to its block", async () => {
  const root = tree({
    "mizzen.yml": "title: Reference\n",
    "_data/context-packs.yml": "- topic: Install\n  budget: 20000\n",
    "guide/install.md": "# Install {#install}\n\n## Steps {#steps}\n\nInstall the engine before you configure the site.\n",
  });
  try {
    await build({ root, out: join(root, "..", "out"), themeRoot: THEME, defaultLayout: "doc", updateBlocks: true });
    const writes: string[] = [];
    const code = await main(["pack", root, "--format", "json"], {
      write: (text) => writes.push(text),
      error: () => {},
      log: () => {},
    });
    assert.equal(code, 0);
    const evidence = JSON.parse(writes.join("")) as { items: { sections: { reference?: { version: number; page: string; block: string; build?: string } }[] }[] };
    const reference = evidence.items.flatMap((item) => item.sections).find((section) => section.reference?.block === "steps")?.reference;
    assert.ok(reference !== undefined, "the install section carries its block reference");
    assert.equal(reference.version, 1);
    assert.equal(reference.page, "guide/install.md");
    assert.equal(reference.build, version);
    const now = await state(root);
    assert.equal(resolveReference(reference as never, now).url, "/guide/install/");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a batch of stored references is checked in one call", async () => {
  const root = await locked();
  const file = join(root, "..", "refs.json");
  try {
    const references = [
      { version: 1, page: "guide/blocks.md", block: "note" },
      { version: 1, page: "guide/blocks.md", block: "b-0000000000" },
    ];
    writeFileSync(file, `${JSON.stringify(references)}\n`);
    const writes: string[] = [];
    const errors: string[] = [];
    const code = await main(["references", "check", file, root], {
      write: (text) => writes.push(text),
      error: (message) => errors.push(message),
      log: () => {},
    });
    assert.equal(code, 1, "an unresolved reference fails the batch");
    assert.deepEqual(errors, []);
    const resolutions = JSON.parse(writes.join("")) as { status: string; url?: string }[];
    assert.deepEqual(resolutions.map((resolution) => resolution.status), ["resolved", "unknown"]);
    assert.equal(resolutions[0]!.url, "/guide/blocks/");
    const ok = join(root, "..", "ok.json");
    writeFileSync(ok, `${JSON.stringify([references[0]])}\n`);
    assert.equal(await main(["references", "check", ok, root], { write: () => {}, error: () => {}, log: () => {} }), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(file, { force: true });
  }
});

test("one reference resolves in the site, MCP, and pack after a second build", async () => {
  const root = tree({
    "mizzen.yml": "title: Reference\n",
    "_data/context-packs.yml": "- topic: Install\n  budget: 20000\n",
    "guide/install.md": "---\ntitle: Install\n---\n\n# Install {#install}\n\n## Steps {#steps}\n\nInstall the engine before you configure the site.\n",
  });
  const reference = { version: 1 as const, page: "guide/install.md", block: "steps" };
  try {
    await build({ root, out: join(root, "..", "out"), themeRoot: THEME, defaultLayout: "doc", updateBlocks: true });
    assert.equal(resolveReference(reference, await state(root)).url, "/guide/install/");

    // The second build moves the page and adds a field to its title.
    const moved = "---\ntitle: Install the engine\npermalink: /engine/\n---\n\n# Install {#install}\n\n## Steps {#steps}\n\nInstall the engine before you configure the site.\n";
    writeFileSync(join(root, "guide/install.md"), moved);
    await build({ root, out: join(root, "..", "out"), themeRoot: THEME, defaultLayout: "doc" });

    assert.equal(resolveReference(reference, await state(root)).url, "/engine/");

    const h = await harness(root);
    try {
      const found = await h.call("get_block_source", { page: "/engine/", block: "steps" });
      assert.equal(found.data.status, "found");
      assert.equal(found.data.block, "steps");
    } finally {
      await h.close();
    }

    const writes: string[] = [];
    assert.equal(await main(["pack", root, "--format", "json"], { write: (text) => writes.push(text), error: () => {}, log: () => {} }), 0);
    const evidence = JSON.parse(writes.join("")) as { items: { url: string; sections: { reference?: { block: string } }[] }[] };
    const item = evidence.items.find((entry) => entry.sections.some((section) => section.reference?.block === "steps"));
    assert.equal(item?.url, "/engine/");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
