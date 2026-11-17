import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Page } from "../src/contracts/content.ts";
import { compareClaims } from "../src/drift/compare.ts";

const root = fileURLToPath(new URL("../fixtures/api-contract-check/", import.meta.url));

/** A Markdown page whose body starts at `line` in its source file. */
function page(markdown: string): Page {
  return {
    url: "/widgets/",
    source: { file: "docs/widgets.md", line: 1, column: 1, endLine: 1, endColumn: 1 },
    frontMatter: {},
    title: "Widgets",
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "",
    markdown,
    kind: "doc",
  };
}

/** The diagnostics of one Markdown body against the fixture. */
async function compare(markdown: string): Promise<Awaited<ReturnType<typeof compareClaims>>> {
  return compareClaims([page(markdown)], { root });
}

test("the fixture's function parameter and interface member claims are clean", async () => {
  const markdown = await readFile(join(root, "docs/widgets.md"), "utf8");
  assert.deepEqual(await compare(markdown), []);
});

test("a changed parameter is reported at the claim, and removal or an unchecked form is never clean", async () => {
  const markdown = await readFile(join(root, "docs/widgets.md"), "utf8");

  const changed = await compare(markdown.replace("name: string", "name: number"));
  assert.equal(changed.length, 1);
  assert.equal(changed[0]?.id, "drift.signature-mismatch");
  assert.equal(changed[0]?.pos?.file, "docs/widgets.md");
  assert.equal(changed[0]?.pos?.line, 3);
  assert.match(changed[0]?.message ?? "", /"src\/widget\.ts".*line 10/);

  const removed = await compare(markdown.replace("createWidget", "makeWidget"));
  assert.equal(removed[0]?.id, "drift.missing-symbol");
  assert.equal(removed[0]?.pos?.line, 3);

  const unchecked = await compare(markdown.replace("createWidget(name: string, options?: WidgetOptions): Widget", "createWidget(...args)"));
  assert.equal(unchecked[0]?.id, "drift.signature-unchecked");
  assert.equal(unchecked[0]?.pos?.line, 3);
});
