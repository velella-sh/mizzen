import assert from "node:assert/strict";
import { test } from "node:test";
import type { Heading, Link, List, Nodes, Root, Table, Text } from "mdast";
import { loadMarkdownPlugins, parseMarkdown } from "../src/markdown/parse.ts";
import { markdownToHtml } from "../src/markdown/to-html.ts";

function visit(node: Nodes, visitFn: (n: Nodes) => void): void {
  visitFn(node);
  if ("children" in node) {
    for (const child of node.children) visit(child, visitFn);
  }
}

function firstOfType<T extends Nodes["type"]>(tree: Root, type: T): Extract<Nodes, { type: T }> {
  let found: Extract<Nodes, { type: T }> | undefined;
  visit(tree, (n) => {
    if (!found && n.type === type) found = n as Extract<Nodes, { type: T }>;
  });
  assert.ok(found, `expected a ${type} node`);
  return found;
}

test("plugins are discovered from the folder and sorted by order then name", async () => {
  const plugins = await loadMarkdownPlugins();
  assert.ok(plugins.some((p) => p.name === "gfm"));
  assert.deepEqual(
    plugins.map((p) => p.name),
    [...plugins].sort((a, b) => a.order - b.order || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map((p) => p.name),
  );
  assert.equal(plugins[0]?.name, "gfm");
  assert.equal(plugins[0]?.order, 0);
});

test("headings keep positions, offset by bodyLine", async () => {
  const body = "# Title\n\nparagraph\n";
  const tree = await parseMarkdown(body, 5);
  const heading = firstOfType(tree, "heading") as Heading;
  assert.equal(heading.depth, 1);
  assert.equal((heading.children[0] as Text).value, "Title");
  assert.equal(heading.position?.start.line, 5);
  assert.equal(heading.position?.start.column, 1);
  const paragraph = firstOfType(tree, "paragraph");
  assert.equal(paragraph.position?.start.line, 7);
});

test("bodyLine 1 leaves positions as remark reports them", async () => {
  const tree = await parseMarkdown("# A\n", 1);
  assert.equal(firstOfType(tree, "heading").position?.start.line, 1);
});

test("GFM: table, task list, strikethrough, and autolink", async () => {
  const body = [
    "| a | b |",
    "| - | - |",
    "| 1 | 2 |",
    "",
    "- [x] done",
    "",
    "~~old~~",
    "",
    "See https://example.com.",
    "",
  ].join("\n");
  const tree = await parseMarkdown(body, 1);

  const table = firstOfType(tree, "table") as Table;
  assert.equal(table.children.length, 2);

  const list = firstOfType(tree, "list") as List;
  assert.equal(list.children[0]?.checked, true);

  let strike = false;
  let autolink = false;
  visit(tree, (n) => {
    if (n.type === "delete") strike = true;
    if (n.type === "link") {
      const link = n as Link;
      if (link.url === "https://example.com") autolink = true;
    }
  });
  assert.equal(strike, true);
  assert.equal(autolink, true);
});

test("a fence's data-code carries highlight, line numbers, and annotations for the renderer", async () => {
  const body = "```ts showLineNumbers {2} annotations={1-2: reads the token | 3: logs it}\na\nb\nc\n```\n";
  const tree = await parseMarkdown(body, 1);
  const { html } = await markdownToHtml(tree, "guide/page.md");

  const raw = /data-code="([^"]*)"/.exec(html)?.[1] ?? "";
  const meta = JSON.parse(raw.replace(/&#x22;|&quot;/g, '"').replace(/&#x26;|&amp;/g, "&")) as {
    highlight: { from: number; to: number }[];
    showLineNumbers: boolean;
    annotations: { from: number; to: number; text: string }[];
  };
  assert.deepEqual(meta.highlight, [{ from: 2, to: 2 }]);
  assert.equal(meta.showLineNumbers, true);
  assert.deepEqual(meta.annotations, [
    { from: 1, to: 2, text: "reads the token" },
    { from: 3, to: 3, text: "logs it" },
  ]);
  assert.equal(
    html.replace(/data-code="[^"]*"/, "").includes("reads the token"),
    false,
    "the note travels only in the data-code attribute",
  );
});
