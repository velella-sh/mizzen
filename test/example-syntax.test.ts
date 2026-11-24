/**
 * The opt-in executable-fence syntax (#1325). A bare `test` token still means an example; every other attribute is
 * optional and only refines it. A fence without `test` is untouched.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMarkdown } from "../src/markdown/parse.ts";
import { examplesIn, isExampleMeta, type MarkdownExample } from "../src/markdown/plugins/example-fence.ts";
import { attributesOf, parseExampleSyntax, validExampleId } from "../src/examples/syntax.ts";

/** The examples of a Markdown body. */
async function examplesOfBody(markdown: string): Promise<MarkdownExample[]> {
  return examplesIn(await parseMarkdown(markdown, 1));
}

test("a bare test token still marks an example, exactly as before", async () => {
  assert.equal(isExampleMeta("test"), true);
  const [example] = await examplesOfBody("```ts test\nconsole.log(1);\n```\n");
  assert.deepEqual(example, {
    id: "example-1",
    lang: "ts",
    code: "console.log(1);",
    expected: null,
    pos: { line: 1, column: 1, endLine: 3, endColumn: 3 },
  });
});

test("a fence without test keeps its bytes and carries no example data", async () => {
  const examples = await examplesOfBody("```ts\nconst a = 1;\n```\n");
  assert.deepEqual(examples, []);
});

test("attributes parse one at a time and total on bad input", () => {
  assert.deepEqual(attributesOf('id="a" session="s" hidden'), [
    { key: "id", value: "a" },
    { key: "session", value: "s" },
    { key: "hidden", value: undefined },
  ]);
  const bad = parseExampleSyntax('id="" timeoutMs="soon" memoryMb="-1" network="unknown"');
  assert.equal(bad.id, undefined, "an empty id is not one");
  assert.equal(bad.timeoutMs, undefined, "a non-numeric timeout is dropped");
  assert.equal(bad.memoryMb, undefined, "a negative memory limit is dropped");
  assert.equal(bad.network, "deny", "an unknown network policy falls back to deny");
});

test("the role, the id, the session, and hidden are read from a fence", async () => {
  const examples = await examplesOfBody([
    "```js test id=\"setup\" role=\"setup\" hidden",
    "console.log(1);",
    "```",
    "```js test id=\"main\" session=\"run\"",
    "console.log(2);",
    "```",
    "```bash test id=\"step\" step runbook=\"install\" precondition=\"test -f a\"",
    "echo hi",
    "```",
    "",
  ].join("\n"));
  assert.deepEqual(examples.map((example) => example.id), ["setup", "main", "step"]);
  assert.equal(examples[0]?.role, "setup");
  assert.equal(examples[0]?.hidden, true);
  assert.equal(examples[1]?.session, "run");
  assert.equal(examples[2]?.role, "step");
  assert.equal(examples[2]?.runbook, "install");
  assert.equal(examples[2]?.precondition, "test -f a");
});

test("an adjacent output fence is stdout, an adjacent stderr fence is stderr", async () => {
  const [example] = await examplesOfBody([
    "```js test",
    'console.error("bad"); console.log("ok");',
    "```",
    "```output",
    "ok",
    "```",
    "```stderr",
    "bad",
    "```",
    "",
  ].join("\n"));
  assert.equal(example?.expected, "ok");
  assert.equal(example?.expectedStderr, "bad");
});

test("a pattern match is declared on the example or on the expected fence", async () => {
  const [onFence] = await examplesOfBody("```js test\nconsole.log(1);\n```\n```output match=\"pattern\"\n\\d+\n```\n");
  assert.equal(onFence?.stdoutMatch, "pattern");
  const [onExample] = await examplesOfBody("```js test match=\"pattern\"\nconsole.log(1);\n```\n```output\n\\d+\n```\n");
  assert.equal(onExample?.stdoutMatch, "pattern");
});

test("a snippet attribute names a file and an optional range", () => {
  assert.deepEqual(parseExampleSyntax('test snippet="lib/math.ts:2-10"').snippet, { file: "lib/math.ts", lines: "2-10" });
  assert.deepEqual(parseExampleSyntax('test snippet="lib/math.ts"').snippet, { file: "lib/math.ts" });
});

test("an explicit id must be a safe slug", () => {
  assert.equal(validExampleId("install-guide"), true);
  assert.equal(validExampleId("example-1"), true);
  assert.equal(validExampleId("Install"), false);
  assert.equal(validExampleId("with space"), false);
});

test("the limits are read as positive integers only", () => {
  assert.equal(parseExampleSyntax("test timeoutMs=2500").timeoutMs, 2500);
  assert.equal(parseExampleSyntax("test memoryMb=64").memoryMb, 64);
  assert.equal(parseExampleSyntax("test timeoutMs=0").timeoutMs, undefined);
});

test("the default for a plain example is an inline output block with no session and no extras", async () => {
  const [example] = await examplesOfBody("```js test\nconsole.log(1);\n```\n");
  assert.equal(example?.role, undefined);
  assert.equal(example?.session, undefined);
  assert.equal(example?.network, undefined);
  assert.equal(example?.hidden, undefined);
});
