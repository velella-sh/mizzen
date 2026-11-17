import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Root } from "mdast";
import { buildModel } from "../../src/model/build.ts";
import { parseMarkdown } from "../../src/markdown/parse.ts";
import { mathDiagnostics } from "../../src/markdown/plugins/math.ts";
import { markdownToHtml } from "../../src/markdown/to-html.ts";

const FIXTURE = fileURLToPath(new URL("../../fixtures/math/site/", import.meta.url));

/** Parse a page and render it the way the Markdown stage does. */
async function htmlOf(body: string, bodyLine = 1): Promise<string> {
  const tree = await parseMarkdown(body, bodyLine);
  return (await markdownToHtml(tree, "page.md")).html;
}

async function parsed(body: string, bodyLine = 1): Promise<Root> {
  return parseMarkdown(body, bodyLine);
}

test("inline math renders fixed MathML with dir, alttext, and the TeX annotation", async () => {
  const html = await htmlOf("The area is $a^2$ and the ratio is $\\frac{a}{b}$.\n");

  assert.ok(
    html.includes('<math display="inline" dir="ltr" alttext="a^2"'),
    "inline math is a left-to-right math element with the TeX as alt text",
  );
  assert.match(html, /<msup><mi>a<\/mi><mn>2<\/mn><\/msup>/);
  assert.ok(html.includes('<annotation encoding="application/x-tex">a^2</annotation>'));
  assert.ok(html.includes('<math display="inline" dir="ltr" alttext="\\frac{a}{b}"'));
  assert.match(html, /<mfrac><mi>a<\/mi><mi>b<\/mi><\/mfrac>/);
  assert.ok(html.includes('<annotation encoding="application/x-tex">\\frac{a}{b}</annotation>'));
});

test("block math is one block math element, not a paragraph, with the same attributes", async () => {
  const html = await htmlOf("$$\n\\frac{a}{b} = c\n$$\n");

  assert.ok(html.startsWith('<math display="block" dir="ltr" alttext="\\frac{a}{b} = c"'));
  assert.doesNotMatch(html, /<p\b[^>]*>\s*<math display="block"/);
  assert.match(html, /<mfrac><mi>a<\/mi><mi>b<\/mi><\/mfrac><mo>=<\/mo><mi>c<\/mi>/);
  assert.ok(
    html.includes('<annotation encoding="application/x-tex">\\frac{a}{b} = c</annotation></semantics></math>'),
  );
});

test("a block may hold blank lines and keeps the TeX between the delimiters", async () => {
  const html = await htmlOf("$$\na + b\n\nc\n$$\n");
  assert.ok(html.includes('alttext="a + b\n\nc"'));
  assert.match(html, /<mi>a<\/mi><mo>\+<\/mo><mi>b<\/mi><mi>c<\/mi>/);
});

test("code spans and escaped dollars stay text", async () => {
  const html = await htmlOf("A literal dollar costs \\$5, `$a^2$` stays code, and $x$ is math.\n");

  assert.equal((html.match(/<math /g) ?? []).length, 1, "only the real formula becomes math");
  assert.match(html, /costs \$5, <code>\$a\^2\$<\/code> stays code/);
  assert.ok(html.includes('alttext="x"'));
});

test("an escaped dollar does not open a formula with a later dollar", async () => {
  const html = await htmlOf("Costs \\$5 and $6$.\n");

  assert.equal((html.match(/<math /g) ?? []).length, 1);
  assert.match(html, /Costs \$5 and <math display="inline" dir="ltr" alttext="6"/);
});

test("an unsupported TeX command keeps the source in a code element and reports info", async () => {
  const body = "An unsupported command: $\\unknown{a}$.\n";
  const tree = await parsed(body);
  const diagnostics = mathDiagnostics(tree, "page.md");

  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.id, "math.unsupported");
  assert.equal(diagnostics[0]?.severity, "info");
  assert.equal(diagnostics[0]?.pos?.line, 1);
  assert.equal(diagnostics[0]?.pos?.file, "page.md");

  const html = (await markdownToHtml(tree, "page.md")).html;
  assert.doesNotMatch(html, /<math\b/);
  assert.match(html, /<code>\\unknown\{a\}<\/code>/);
});

test("an unbalanced brace keeps the source in a code element and reports a warning", async () => {
  const tree = await parsed("Broken $a^{b$.\n");
  const diagnostics = mathDiagnostics(tree, "guide/page.md");

  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.id, "math.syntax");
  assert.equal(diagnostics[0]?.severity, "warning");
  assert.equal(diagnostics[0]?.pos?.line, 1);

  const html = (await markdownToHtml(tree, "page.md")).html;
  assert.doesNotMatch(html, /<math\b/);
  assert.match(html, /<code>a\^\{b<\/code>/);
});

test("an empty pair warns and an unclosed block fails at its opening line", async () => {
  const empty = mathDiagnostics(await parsed("An empty pair: $$ $$.\n"), "page.md");
  assert.ok(empty.some((finding) => finding.id === "math.empty" && finding.severity === "warning"));

  const tree = await parsed("Intro\n\n$$\na + b\n", 5);
  const diagnostics = mathDiagnostics(tree, "guide/page.md");
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.id, "math.unclosed-block");
  assert.equal(diagnostics[0]?.severity, "error");
  assert.equal(diagnostics[0]?.pos?.line, 7, "the opening $$ line, in the page's source file");
  assert.equal(diagnostics[0]?.pos?.column, 1);
});

test("the Markdown twin keeps the original inline and block forms", async () => {
  const result = await buildModel(FIXTURE);
  assert.deepEqual(result.diagnostics, []);

  const page = result.site.pages.find((candidate) => candidate.url === "/");
  assert.ok(page, "the fixture page is built");
  assert.match(page.markdown, /The area is \$a\^2\$ and the ratio is \$\\frac\{a\}\{b\}\$/);
  assert.match(page.markdown, /\$\$\n\\frac\{a\}\{b\} = c\n\$\$/);
  assert.match(page.markdown, /A literal dollar costs \\\$5/);
  assert.match(page.markdown, /`\$a\^2\$` in a code span stays text/);
  assert.match(page.html, /<math display="inline"/);
  assert.match(page.html, /<math display="block"/);
});

test("the same source renders the same HTML on every run", async () => {
  const body = "Inline $a^2$.\n\n$$\n\\sum_{i=1}^{n} i\n$$\n";
  assert.equal(await htmlOf(body), await htmlOf(body));
});
