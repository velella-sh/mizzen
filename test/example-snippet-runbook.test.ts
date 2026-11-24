/**
 * Snippets imported from files (#1332), and multi-step runbooks (#1333). A snippet reads through the same boundary as
 * `::include`, so a change to the source invalidates its evidence; a runbook runs allowlisted shell steps in order and
 * stops at the first failure.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { MarkdownExample } from "../src/markdown/plugins/example-fence.ts";
import { loadSnippet } from "../src/examples/snippet.ts";
import { commandNameOf, isAllowed, runRunbook } from "../src/examples/runbook.ts";

/** A temporary source folder, removed by the caller. */
async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "example-snippet-"));
  return root;
}

/** A fence with an explicit span for a snippet read. */
function example(line = 10): MarkdownExample {
  return { id: "example-1", lang: "ts", code: "", expected: null, pos: { line, column: 1, endLine: line + 2, endColumn: 4 } };
}

test("a snippet is read by range with the language its extension gives it", async () => {
  const root = await scratch();
  try {
    await mkdir(join(root, "lib"), { recursive: true });
    await writeFile(join(root, "lib", "math.ts"), "export const a = 1;\nexport function add(x: number, y: number) { return x + y; }\nexport const b = 2;\n");
    const result = await loadSnippet({ snippet: { file: "lib/math.ts", lines: "2-2" }, sourceDir: root, example: example(), file: "guide.md" });
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.snippet?.code, "export function add(x: number, y: number) { return x + y; }");
    assert.equal(result.snippet?.lang, "ts");
    assert.equal(result.snippet?.file, "lib/math.ts");
    assert.equal(result.snippet?.start, 2);
    assert.equal(result.snippet?.end, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing snippet is one finding at the fence, not a throw", async () => {
  const root = await scratch();
  try {
    const result = await loadSnippet({ snippet: { file: "nope.ts" }, sourceDir: root, example: example(), file: "guide.md" });
    assert.equal(result.snippet, undefined);
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0]?.id, "example-snippet");
    assert.equal(result.diagnostics[0]?.severity, "error");
    assert.equal(result.diagnostics[0]?.pos?.line, 10);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a snippet outside the source folder is refused", async () => {
  const root = await scratch();
  try {
    const result = await loadSnippet({ snippet: { file: "../outside.ts" }, sourceDir: root, example: example(), file: "guide.md" });
    assert.equal(result.snippet, undefined);
    assert.equal(result.diagnostics[0]?.id, "example-snippet");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a runbook runs allowlisted steps in order", async () => {
  const result = await runRunbook(
    {
      name: "install",
      allowed: ["echo", "test", "cat"],
      steps: [
        { id: "one", command: "echo first" },
        { id: "two", command: "echo second", expected: "second" },
      ],
    },
    { timeoutMs: 10_000, memoryMb: 0, network: "deny" },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.steps.map((step) => step.status), ["passed", "passed"]);
});

test("an allowlist refusal stops the runbook before the next step and has no side effect", async () => {
  await mkdir(join(tmpdir(), "unused"), { recursive: true });
  const result = await runRunbook(
    {
      name: "install",
      allowed: ["echo"],
      steps: [
        { id: "one", command: "echo first" },
        { id: "two", command: "rm -rf /tmp/whatever" },
        { id: "three", command: "echo never" },
      ],
    },
    { timeoutMs: 10_000, memoryMb: 0, network: "deny" },
  );
  assert.equal(result.ok, false);
  assert.equal(result.stoppedAt, 1);
  assert.deepEqual(result.steps.map((step) => step.status), ["passed", "refused"]);
});

test("a failed precondition stops before the step runs", async () => {
  const result = await runRunbook(
    {
      name: "install",
      allowed: ["test", "echo"],
      steps: [{ id: "one", command: "echo should-not-run", precondition: "test -f /nonexistent-file-xyz" }],
    },
    { timeoutMs: 10_000, memoryMb: 0, network: "deny" },
  );
  assert.equal(result.ok, false);
  assert.equal(result.steps[0]?.status, "precondition");
});

test("a step's wrong output stops the runbook", async () => {
  const result = await runRunbook(
    {
      name: "install",
      allowed: ["echo"],
      steps: [
        { id: "one", command: "echo actual", expected: "expected" },
        { id: "two", command: "echo never" },
      ],
    },
    { timeoutMs: 10_000, memoryMb: 0, network: "deny" },
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.steps.map((step) => step.status), ["mismatch"]);
  assert.equal(result.steps[0]?.expected, "expected");
  assert.equal(result.steps[0]?.actual, "actual");
});

test("the first word of a command names it for the allowlist", () => {
  assert.equal(commandNameOf("echo hi"), "echo");
  assert.equal(commandNameOf("/usr/bin/env node app.js"), "env");
  assert.equal(commandNameOf("PATH=/x echo hi"), "echo");
  assert.equal(isAllowed("echo hi", ["echo"]), true);
  assert.equal(isAllowed("rm -rf /", ["echo"]), false);
  assert.equal(isAllowed("echo hi", ["echo hi"]), true);
});
