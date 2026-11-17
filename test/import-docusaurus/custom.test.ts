import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { convertCustomComponents } from "../../src/import/docusaurus/diagnostics.ts";

const FIXTURE = "fixtures/import-docusaurus/docs/configure-a-token.mdx";

test("the fixture's Card keeps its Markdown and is reported at its opening tag", () => {
  const source = readFileSync(new URL(`../../${FIXTURE}`, import.meta.url), "utf8");
  const { markdown, diagnostics } = convertCustomComponents(source, FIXTURE);

  assert.equal(diagnostics.length, 1);
  const [card] = diagnostics;
  assert.equal(card?.id, "import.component");
  assert.equal(card?.severity, "warning");
  assert.match(card!.message, /<Card>/);
  assert.deepEqual(card?.pos, { file: FIXTURE, line: 38, column: 1, endLine: 38, endColumn: 29 });
  assert.match(markdown, /Run `beacon token rotate` before the expiry date\./);
  assert.doesNotMatch(markdown, /<\/?Card/);
  // Tabs and TabItem belong to the component converter, not this pass.
  assert.match(markdown, /<Tabs groupId="shell">/);
});

test("a component used twice is reported once, at its first tag", () => {
  const source = 'import Card from "@site/src/components/Card";\n\n<Card kind="a">first</Card>\n\n<Card kind="b">second</Card>\n';
  const { markdown, diagnostics } = convertCustomComponents(source, "page.mdx");

  assert.deepEqual(
    diagnostics.map((d) => [d.id, d.pos?.line, d.pos?.column]),
    [["import.component", 3, 1]],
  );
  assert.doesNotMatch(markdown, /<\/?Card/);
  assert.match(markdown, /first/);
  assert.match(markdown, /second/);
});

test("nested custom components are reported once each, in document order", () => {
  const source = "<Outer>\n  <Inner>text</Inner>\n</Outer>\n";
  const { markdown, diagnostics } = convertCustomComponents(source, "page.mdx");

  assert.deepEqual(
    diagnostics.map((d) => d.message.match(/<(\w+)>/)?.[1]),
    ["Outer", "Inner"],
  );
  assert.equal(markdown, "\n  text\n\n");
});

test("tags in fenced and inline code are examples, not components", () => {
  const source = "Run `<Card>inline</Card>` in the shell.\n\n```mdx\n<Card>fenced</Card>\n```\n";
  const result = convertCustomComponents(source, "page.mdx");

  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.markdown, source);
});

test("plain HTML and theme components are left alone", () => {
  const source = "import Tabs from '@theme/Tabs';\n\n<Tabs>\n<div class=\"note\">text</div>\n</Tabs>\n";
  assert.deepEqual(convertCustomComponents(source, "page.mdx"), { markdown: source, diagnostics: [] });
});
