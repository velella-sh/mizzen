/**
 * Mapping for #535: an example runs only when an explicit command check names its id. The real Offing guide has
 * five `test` fences and two normal fences; a check list selects some of the five, and a bad id is an error.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Page } from "../../src/contracts/index.ts";
import {
  COMMAND_CHECK_DUPLICATE_ID,
  COMMAND_CHECK_UNKNOWN_ID,
  commandChecks,
} from "../../src/examples/command-checks.ts";
import { examplesOf } from "../../src/markdown/plugins/example-fence.ts";

const GUIDE = new URL("./fixtures/offing/quickstart.md", import.meta.url);
const FILE = "test/docs-command-check/fixtures/offing/quickstart.md";

/** The guide's body starts after its front matter. */
function page(): Page {
  const text = readFileSync(GUIDE, "utf8");
  const start = text.indexOf("# Quickstart");
  const markdown = text.slice(start);
  const line = text.slice(0, start).split("\n").length;
  return {
    url: "/quickstart/",
    source: { file: FILE, line, column: 1, endLine: line + markdown.split("\n").length, endColumn: 1 },
    frontMatter: {},
    title: "Quickstart",
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "",
    markdown,
    kind: "doc",
  };
}

test("only declared blocks are mapped, in declaration order", async () => {
  const examples = await examplesOf(page());
  assert.equal(examples.length, 5, "the guide has five `test` fences, not seven fenced blocks");
  assert.deepEqual(examples.map((example) => example.id), [
    "example-1",
    "example-2",
    "example-3",
    "example-4",
    "example-5",
  ]);

  const { checks, diagnostics } = commandChecks(examples, [
    { id: "example-4", test: "test/docs-command-check/context.test.ts" },
    { id: "example-2", test: "test/docs-command-check/check.test.ts" },
  ]);

  assert.deepEqual(diagnostics, []);
  assert.deepEqual(checks.map((check) => check.example.id), ["example-4", "example-2"]);
  assert.deepEqual(checks.map((check) => check.test), [
    "test/docs-command-check/context.test.ts",
    "test/docs-command-check/check.test.ts",
  ]);
  assert.match(checks[0]!.example.code, /offing context/);
  assert.match(checks[1]!.example.code, /offing check/);
  assert.equal(checks[0]!.example.pos.file, FILE);
  assert.ok(checks[0]!.example.pos.line > 0, "the mapped block keeps its source line");
});

test("an example that is not declared is not mapped", async () => {
  const examples = await examplesOf(page());
  const { checks } = commandChecks(examples, [{ id: "example-1", test: "test/docs-command-check/scan.test.ts" }]);
  assert.deepEqual(checks.map((check) => check.example.id), ["example-1"]);
  assert.equal(checks.some((check) => check.example.id === "example-3"), false);
});

test("a duplicate id is an error and produces no check", async () => {
  const examples = await examplesOf(page());
  const { checks, diagnostics } = commandChecks(examples, [
    { id: "example-1", test: "test/docs-command-check/scan.test.ts" },
    { id: "example-1", test: "test/docs-command-check/other.test.ts" },
  ]);
  assert.deepEqual(checks, []);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.id, COMMAND_CHECK_DUPLICATE_ID);
  assert.equal(diagnostics[0]?.severity, "error");
  assert.match(diagnostics[0]?.message ?? "", /example-1/);
});

test("an unknown id is an error and does not suppress a valid check", async () => {
  const examples = await examplesOf(page());
  const { checks, diagnostics } = commandChecks(examples, [
    { id: "example-99", test: "test/docs-command-check/missing.test.ts" },
    { id: "example-5", test: "test/docs-command-check/baseline.test.ts" },
  ]);
  assert.deepEqual(checks.map((check) => check.example.id), ["example-5"]);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.id, COMMAND_CHECK_UNKNOWN_ID);
  assert.equal(diagnostics[0]?.severity, "error");
  assert.match(diagnostics[0]?.message ?? "", /example-99/);
});
