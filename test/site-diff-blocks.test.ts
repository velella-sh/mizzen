import assert from "node:assert/strict";
import { test } from "node:test";
import { diffBuilds } from "../src/diff/index.ts";
import { cleanup, writeBuild } from "./site-diff-builds.ts";

const page = (md: string, html?: string) => ({ url: "/g/", title: "G", md, ...(html === undefined ? {} : { html }) });
const doc = "# G\n\n## One\n\nalpha\n\n## Two\n\nbeta\n\n## Three\n\ngamma\n";

async function blocks(before: string, after: string, htmlBefore?: string, htmlAfter?: string) {
  const a = await writeBuild({ pages: [page(before, htmlBefore)] });
  const b = await writeBuild({ pages: [page(after, htmlAfter)] });
  const diff = await diffBuilds(a, b);
  cleanup(a, b);
  return diff.pages.changed[0]!;
}

test("an edited section is named by heading", async () => {
  const changed = await blocks(doc, doc.replace("beta", "beta two"));
  assert.deepEqual(changed.blocks.map((b) => [b.heading, b.kind]), [["Two", "edited"]]);
  assert.ok(changed.blocks[0]!.range);
  assert.equal(changed.renderOnly, false);
});

test("an added section is reported as added", async () => {
  const changed = await blocks(doc, `${doc}\n## Four\n\ndelta\n`);
  assert.deepEqual(changed.blocks.map((b) => [b.heading, b.kind]), [["Four", "added"]]);
});

test("a moved section is reported as moved", async () => {
  const moved = "# G\n\n## Two\n\nbeta\n\n## One\n\nalpha\n\n## Three\n\ngamma\n";
  const changed = await blocks(doc, moved);
  assert.ok(changed.blocks.some((b) => b.kind === "moved"));
});

test("a change in the HTML alone is render-only", async () => {
  const changed = await blocks(doc, doc, "<p>a</p>", "<p>b</p>");
  assert.deepEqual(changed.changes, ["html"]);
  assert.equal(changed.renderOnly, true);
  assert.deepEqual(changed.blocks, []);
});
