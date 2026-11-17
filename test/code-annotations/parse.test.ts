import assert from "node:assert/strict";
import { test } from "node:test";
import type { Code, Root } from "mdast";
import { parseMarkdown } from "../../src/markdown/parse.ts";
import { annotationDiagnostics, parseAnnotations } from "../../src/markdown/plugins/code-annotations.ts";

/** The only code block in a parsed page. */
function codeOf(tree: Root): Code {
  const code = tree.children.find((node): node is Code => node.type === "code");
  assert.ok(code, "the page has a code block");
  return code;
}

test("valid annotations map to line ranges and notes in line order, with escapes decoded", () => {
  const meta =
    "ts annotations={5: logs a or b \\| c | 1: reads the token once | 3-4: `connect` retries on a timeout}";
  assert.deepEqual(parseAnnotations(meta, 5), {
    annotations: [
      { from: 1, to: 1, text: "reads the token once" },
      { from: 3, to: 4, text: "`connect` retries on a timeout" },
      { from: 5, to: 5, text: "logs a or b | c" },
    ],
    issues: [],
  });
});

test("a valid fence reports no diagnostic and keeps its code bytes", async () => {
  const body = [
    "```ts annotations={1: reads the token once | 3-4: retries on a timeout | 5: logs the result}",
    "const token = read();",
    "const client = connect(token);",
    "const first = await client.scan();",
    "const second = await client.scan();",
    "log(first, second);",
    "```",
    "",
  ].join("\n");
  const tree = await parseMarkdown(body);
  const code = codeOf(tree);

  assert.deepEqual(annotationDiagnostics(tree, "page.md"), []);
  assert.equal(code.value.split("\n").length, 5);
  assert.equal(code.meta?.startsWith("annotations={1: reads the token once"), true);
});

test("an invalid line is dropped and reported at the fence with the first offending entry", async () => {
  const body = [
    "```ts annotations={0: line zero | 9: past the end | 2-3: first | 3-4: overlaps | missing colon}",
    "const one = 1;",
    "const two = 2;",
    "const three = 3;",
    "const four = 4;",
    "```",
    "",
  ].join("\n");
  const tree = await parseMarkdown(body, 5);
  const code = codeOf(tree);

  assert.deepEqual(parseAnnotations(code.meta ?? "", 4), {
    annotations: [{ from: 2, to: 3, text: "first" }],
    issues: [
      { entry: "0: line zero", problem: "range" },
      { entry: "9: past the end", problem: "range" },
      { entry: "3-4: overlaps", problem: "overlap" },
      { entry: "missing colon", problem: "syntax" },
    ],
  });
  assert.equal(code.value, "const one = 1;\nconst two = 2;\nconst three = 3;\nconst four = 4;");

  assert.deepEqual(
    annotationDiagnostics(tree, "page.md").map((d) => [d.id, d.severity, d.message, d.pos?.file, d.pos?.line]),
    [
      [
        "code.annotation-range",
        "warning",
        'The annotation "0: line zero" is outside the block\'s 4 lines.',
        "page.md",
        5,
      ],
    ],
  );
});

test("each fence reports its first bad entry once, in document order", async () => {
  const body = [
    "```ts annotations={2-3: first | 3-4: second}",
    "one",
    "two",
    "three",
    "four",
    "```",
    "",
    "```ts annotations={missing colon | 1: ok}",
    "one",
    "```",
    "",
    "```ts annotations={1: }",
    "one",
    "```",
    "",
  ].join("\n");
  const found = annotationDiagnostics(await parseMarkdown(body), "page.md");

  assert.deepEqual(
    found.map((d) => [d.id, d.message]),
    [
      ["code.annotation-overlap", 'The annotation "3-4: second" overlaps another annotation.'],
      ["code.annotation-syntax", 'The annotation "missing colon" is not a line with a note; write <line>: <text> or <start>-<end>: <text>.'],
      ["code.annotation-syntax", 'The annotation "1:" is not a line with a note; write <line>: <text> or <start>-<end>: <text>.'],
    ],
  );
});

test("a block without annotations is unchanged", async () => {
  const body = ['```ts title="plain"', "const value = 1;", "```", ""].join("\n");
  const tree = await parseMarkdown(body);
  const code = codeOf(tree);

  assert.equal(code.meta, 'title="plain"');
  assert.equal(code.value, "const value = 1;");
  assert.deepEqual(parseAnnotations(code.meta, 1), { annotations: [], issues: [] });
  assert.deepEqual(annotationDiagnostics(tree, "page.md"), []);
});
