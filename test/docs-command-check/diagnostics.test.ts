/**
 * Diagnostics for #536: a command check's test result becomes a finding at the block that holds the command. The
 * Offing guide's `example-3` is the broken-command case, so its failure points at line 42.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Page } from "../../src/contracts/index.ts";
import { commandChecks, type CheckedCommand } from "../../src/examples/command-checks.ts";
import {
  COMMAND_CHECK_FAILED_ID,
  COMMAND_CHECK_NOT_RUN_ID,
  commandDiagnostics,
} from "../../src/examples/command-diagnostics.ts";
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

/** Resolves the declared checks against the guide. */
async function checked(
  declared: readonly { id: string; test: string }[],
): Promise<readonly CheckedCommand[]> {
  const { checks, diagnostics } = commandChecks(await examplesOf(page()), declared);
  assert.deepEqual(diagnostics, []);
  return checks;
}

test("a passing test adds no finding", async () => {
  const checks = await checked([{ id: "example-1", test: "test/docs-command-check/scan.test.ts" }]);
  const diagnostics = commandDiagnostics(checks, [
    { test: "test/docs-command-check/scan.test.ts", state: "passed" },
  ]);
  assert.deepEqual(diagnostics, []);
});

test("a failure is an error at the block's file and line", async () => {
  const checks = await checked([{ id: "example-3", test: "test/docs-command-check/explain.test.ts" }]);
  const diagnostics = commandDiagnostics(checks, [
    {
      test: "test/docs-command-check/explain.test.ts",
      state: "failed",
      detail: "exit code 1: finding not found",
    },
  ]);

  assert.equal(diagnostics.length, 1);
  const [failure] = diagnostics;
  assert.equal(failure?.id, COMMAND_CHECK_FAILED_ID);
  assert.equal(failure?.severity, "error");
  assert.equal(failure?.pos?.file, FILE);
  assert.equal(failure?.pos?.line, 42, "the explain fence starts at line 42 of the guide");
  assert.deepEqual(failure?.pos, { file: FILE, ...checks[0]!.example.pos }, "the finding spans the block");
  assert.match(failure?.message ?? "", /example-3/);
  assert.match(failure?.message ?? "", /test\/docs-command-check\/explain\.test\.ts/);
  assert.match(failure?.message ?? "", /exit code 1: finding not found/);
});

test("a missing or explicit not-run result is an info finding at the block", async () => {
  const checks = await checked([
    { id: "example-1", test: "test/docs-command-check/scan.test.ts" },
    { id: "example-3", test: "test/docs-command-check/explain.test.ts" },
  ]);
  const diagnostics = commandDiagnostics(checks, [
    { test: "test/docs-command-check/scan.test.ts", state: "not-run", detail: "skipped: no network" },
  ]);

  assert.deepEqual(diagnostics.map((diagnostic) => diagnostic.id), [
    COMMAND_CHECK_NOT_RUN_ID,
    COMMAND_CHECK_NOT_RUN_ID,
  ]);
  assert.deepEqual(diagnostics.map((diagnostic) => diagnostic.severity), ["info", "info"]);
  assert.equal(diagnostics[0]?.pos?.line, 15);
  assert.equal(diagnostics[1]?.pos?.line, 42);
  assert.match(diagnostics[0]?.message ?? "", /skipped: no network/);
  assert.match(diagnostics[1]?.message ?? "", /no result was reported/);
});

test("one test can prove several blocks and each block gets its own failure", async () => {
  const checks = await checked([
    { id: "example-1", test: "test/docs-command-check/guide.test.ts" },
    { id: "example-3", test: "test/docs-command-check/guide.test.ts" },
  ]);
  const diagnostics = commandDiagnostics(checks, [
    { test: "test/docs-command-check/guide.test.ts", state: "failed" },
  ]);

  assert.equal(diagnostics.length, 2);
  assert.deepEqual(diagnostics.map((diagnostic) => diagnostic.pos?.line), [15, 42]);
});
