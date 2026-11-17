import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Nodes, Root } from "mdast";
import { convertComponents } from "../../src/import/docusaurus/components.ts";
import { parseMarkdown } from "../../src/markdown/parse.ts";
import { markdownToHtml } from "../../src/markdown/to-html.ts";

const fixture = readFileSync(
  new URL("../../fixtures/import-docusaurus/docs/configure-a-token.mdx", import.meta.url),
  "utf8",
);

/** The fixture's Markdown body, without its front matter. */
function bodyOf(source: string): string {
  const frontMatter = /^---\n[\s\S]*?\n---\n/.exec(source);
  return frontMatter ? source.slice(frontMatter[0].length) : source;
}

/** Parse converted Markdown and render it the way the Markdown stage does. */
async function htmlOf(markdown: string): Promise<string> {
  return (await markdownToHtml(await parseMarkdown(markdown), "page.mdx")).html;
}

/** Every node in the tree, in document order. */
function everyNode(node: Nodes, found: Nodes[] = []): Nodes[] {
  found.push(node);
  if ("children" in node) {
    for (const child of node.children) everyNode(child as Nodes, found);
  }
  return found;
}

/** The callouts a parsed page contains: their type and title. */
function callouts(tree: Root): { type: string; title?: string }[] {
  const out: { type: string; title?: string }[] = [];
  for (const node of everyNode(tree)) {
    const data = node.data as
      | { hName?: string; hProperties?: Record<string, string> }
      | undefined;
    if (data?.hName !== "sl-component") continue;
    const props = JSON.parse(data.hProperties?.["data-props"] ?? "{}") as Record<string, string>;
    const type = props.type;
    if (type === undefined) continue;
    out.push(props.title === undefined ? { type } : { type, title: props.title });
  }
  return out;
}

test("the fixture's panels become one tab directive each, labels and text intact", () => {
  const converted = convertComponents(bodyOf(fixture));
  const start = converted.indexOf(":::::tabs");
  const end = converted.indexOf(":::::", start + 1);
  assert.notEqual(start, -1, "the group opens");
  assert.notEqual(end, -1, "the group closes");

  assert.equal(
    converted.slice(start, end + ":::::".length),
    [
      ":::::tabs",
      ':::tab{label="Bash"}',
      "Add the token to your shell profile, then start a new shell:",
      "",
      "1. `export BEACON_TOKEN=<token>`",
      "2. `beacon login`",
      ":::",
      ':::tab{label="PowerShell"}',
      "Add the token to your profile, then start a new shell:",
      "",
      "```powershell",
      '$env:BEACON_TOKEN = "<token>"',
      "beacon login",
      "```",
      ":::",
      ":::::",
    ].join("\n"),
  );
  assert.doesNotMatch(converted, /@theme\/|@site\//);
  assert.doesNotMatch(converted, /^import /m);
  assert.doesNotMatch(converted, /groupId/);
  assert.equal(convertComponents(converted), converted, "converting twice changes nothing");
});

test("converted panels parse as Markdown panels, not as code", async () => {
  const html = await htmlOf(convertComponents(bodyOf(fixture)));

  const labels = [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1]);
  assert.deepEqual(labels, ["Bash", "PowerShell"]);
  assert.match(html, /role="tab" id="[^"]+-bash-1" aria-controls="[^"]+" aria-selected="true"/);
  assert.equal((html.match(/<pre\b/g) ?? []).length, 1, "only the fenced code block is code");
  assert.match(html, /<ol data-src=/);
  assert.match(html, /<pre data-src="[^"]+"><code class="language-powershell">/);
  assert.match(html, /Add the token to your shell profile, then start a new shell:/);
  assert.match(html, /Add the token to your profile, then start a new shell:/);
});

test("a default panel moves first and the others keep their order", () => {
  const converted = convertComponents(
    [
      '<Tabs groupId="shell">',
      '  <TabItem value="one" label="One">',
      "    First panel.",
      "  </TabItem>",
      '  <TabItem value="two" label="Two" default>',
      "    Second panel.",
      "  </TabItem>",
      '  <TabItem value="three" label="Three">',
      "    Third panel.",
      "  </TabItem>",
      "</Tabs>",
      "",
    ].join("\n"),
  );

  assert.equal(
    converted,
    [
      ":::::tabs",
      ':::tab{label="Two"}',
      "Second panel.",
      ":::",
      ':::tab{label="One"}',
      "First panel.",
      ":::",
      ':::tab{label="Three"}',
      "Third panel.",
      ":::",
      ":::::",
      "",
    ].join("\n"),
  );
});

test("note and tip stay callouts; info and caution map to note and warning with their title", async () => {
  const converted = convertComponents(
    [
      ":::note",
      "A note.",
      ":::",
      "",
      ":::tip[Write it once]",
      "A tip.",
      ":::",
      "",
      ":::info[Read this]",
      "Some info.",
      ":::",
      "",
      ":::caution",
      "Careful.",
      ":::",
      "",
      ":::warning",
      "Same.",
      ":::",
      "",
    ].join("\n"),
  );

  assert.match(converted, /^:::note\[Read this\]$/m);
  assert.match(converted, /^:::warning$/m);
  assert.doesNotMatch(converted, /^:::(?:info|caution)\b/m);
  assert.deepEqual(callouts(await parseMarkdown(converted)), [
    { type: "note" },
    { type: "tip", title: "Write it once" },
    { type: "note", title: "Read this" },
    { type: "warning" },
    { type: "warning" },
  ]);
});

test("JSX and directives inside a fenced code block are left alone", () => {
  const source = [
    "```md",
    "import Tabs from '@theme/Tabs';",
    '<Tabs groupId="shell">',
    '  <TabItem value="a" label="A">',
    "    Text.",
    "  </TabItem>",
    "</Tabs>",
    ":::info",
    "```",
    "",
  ].join("\n");
  assert.equal(convertComponents(source), source);
});
