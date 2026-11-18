/**
 * A block's stable id reaches every output, and a block removed since the lock names the links that depended on it.
 * Issue #776 covers the first, #777 the second.
 */
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildModel } from "../src/model/build.ts";
import { build } from "../src/pipeline/build.ts";

const FIXTURE = fileURLToPath(new URL("../fixtures/blocks-site", import.meta.url));
const THEME = fileURLToPath(new URL("../../lateen", import.meta.url));

/** A scratch site copied from the block fixture, and the output folder beside it. */
function site(): { root: string; out: string } {
  const parent = mkdtempSync(join(tmpdir(), "blocks-review-"));
  const root = join(parent, "site");
  cpSync(FIXTURE, root, { recursive: true });
  return { root, out: join(parent, "out") };
}

test("HTML, the Markdown twin, and the source map carry one block's id and source", async () => {
  const { root, out } = site();
  try {
    await build({ root, out, themeRoot: THEME, defaultLayout: "doc", updateBlocks: true });

    const map = JSON.parse(readFileSync(join(out, "sourcemap.json"), "utf8")) as {
      pages: { source: string; blocks?: { id: string; file: string; line: number; column: number }[] }[];
    };
    const page = map.pages.find((entry) => entry.source === "guide/blocks.md");
    assert.ok(page?.blocks !== undefined);
    const note = page.blocks.find((block) => block.id === "note");
    assert.ok(note !== undefined);
    assert.equal(note.file, "guide/blocks.md");

    const html = readFileSync(join(out, "guide/blocks/index.html"), "utf8");
    const at = html.indexOf(`data-src="${note.file}:${note.line}:${note.column}-`);
    assert.ok(at >= 0, "the HTML block starts where the source map says");
    assert.ok(html.slice(at, html.indexOf(">", at)).includes('data-block="note"'));
    assert.ok(html.includes('data-block="intro"'));

    const twin = readFileSync(join(out, "guide/blocks/index.md"), "utf8");
    assert.ok(twin.includes("<!-- {#note} -->"), "the twin keeps the declared id");
    assert.ok(twin.includes("{#intro}"));
  } finally {
    rmSync(join(root, ".."), { recursive: true, force: true });
  }
});

test("a removed block names each link that depended on it, with its location", async () => {
  const { root } = site();
  try {
    const first = await build({ root, out: join(root, "..", "out"), themeRoot: THEME, defaultLayout: "doc", updateBlocks: true });

    const plain = join(root, "guide/plain.md");
    const links = `${readFileSync(plain, "utf8")}\n[the intro](blocks.md#intro)\n`;
    writeFileSync(plain, links);
    const line = links.trimEnd().split("\n").length;

    const blockPage = join(root, "guide/blocks.md");
    writeFileSync(blockPage, readFileSync(blockPage, "utf8").replace("# Start here {#intro}\n\n", ""));

    const { diagnostics } = await buildModel(root);
    const removed = diagnostics.filter((diagnostic) => diagnostic.id === "blocks.removed");
    assert.deepEqual(
      removed.map((diagnostic) => [diagnostic.severity, diagnostic.pos?.file, diagnostic.pos?.line]),
      [["warning", "guide/plain.md", line]],
    );
    assert.match(removed[0]!.message, /#intro/);
    assert.match(removed[0]!.message, /"intro"/);
  } finally {
    rmSync(join(root, ".."), { recursive: true, force: true });
  }
});
