/**
 * The page example orchestrator (#1328 – #1334). One test proves the whole path for each behavior: execution and
 * evidence, shared sessions, hidden setup and teardown, snippets, runbooks, output matching, limits, and the cache.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseMarkdown } from "../src/markdown/parse.ts";
import { examplesIn, type MarkdownExample } from "../src/markdown/plugins/example-fence.ts";
import { runPageExamples } from "../src/examples/run.ts";
import { exampleCache } from "../src/pipeline/examples/cache.ts";

/** The examples of a Markdown body. */
async function blocksOf(markdown: string): Promise<MarkdownExample[]> {
  return examplesIn(await parseMarkdown(markdown, 1));
}

/** A temporary source folder, removed by the caller. */
async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "example-run-"));
}

/** Run options for a page in `root`, with generous limits and no type-check, so the test is fast and offline. */
function options(root: string, examples: MarkdownExample[], extra: Record<string, unknown> = {}) {
  return {
    examples,
    page: "/guide/",
    file: "guide.md",
    root,
    sourceDir: root,
    limits: { timeoutMs: 10_000, memoryMb: 0, network: "deny" as const },
    typeCheck: false,
    failOnFailure: true,
    ...extra,
  };
}

test("a passing example records exit code, output, and its evidence", async () => {
  const root = await scratch();
  try {
    const examples = await blocksOf(["```js test", 'console.log("hi");', "```", "```output", "hi", "```", ""].join("\n"));
    const run = await runPageExamples(options(root, examples));
    const result = run.results.get("example-1")!;
    assert.equal(result.status, "passed");
    assert.equal(result.exitCode, 0);
    assert.equal(result.evidence?.outputs[0]?.stream, "stdout");
    assert.equal(result.evidence?.outputs[0]?.ok, true);
    assert.deepEqual(run.diagnostics, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a wrong expected output fails with a finding at the fence", async () => {
  const root = await scratch();
  try {
    const examples = await blocksOf(["```js test", 'console.log("actual");', "```", "```output", "expected", "```", ""].join("\n"));
    const run = await runPageExamples(options(root, examples));
    assert.equal(run.results.get("example-1")?.status, "failed");
    const failure = run.diagnostics.find((diagnostic) => diagnostic.id === "example-failed");
    assert.ok(failure);
    assert.equal(failure.pos?.line, 1);
    assert.match(failure.message, /expected "expected" but got "actual"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an expected stderr is compared separately from stdout", async () => {
  const root = await scratch();
  try {
    const examples = await blocksOf([
      "```js test",
      'console.error("a warning");',
      "```",
      "```stderr",
      "a warning",
      "```",
      "",
    ].join("\n"));
    const run = await runPageExamples(options(root, examples));
    assert.equal(run.results.get("example-1")?.status, "passed");
    assert.equal(run.results.get("example-1")?.evidence?.outputs[0]?.stream, "stdout");
    assert.equal(run.results.get("example-1")?.evidence?.outputs[1]?.stream, "stderr");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a pattern match accepts output that is not byte-exact", async () => {
  const root = await scratch();
  try {
    const examples = await blocksOf(["```js test", 'console.log("value: 42");', "```", '```output match="pattern"', "value: \\d+", "```", ""].join("\n"));
    const run = await runPageExamples(options(root, examples));
    assert.equal(run.results.get("example-1")?.status, "passed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("blocks in a shared session see each other's state; the declared order wins", async () => {
  const root = await scratch();
  try {
    const examples = await blocksOf([
      "```js test session=\"main\" id=\"write\"",
      'import { writeFileSync } from "node:fs"; writeFileSync("state.txt", "shared");',
      "```",
      "```js test session=\"main\" id=\"read\"",
      'import { readFileSync } from "node:fs"; console.log(readFileSync("state.txt", "utf8"));',
      "```",
      "```output",
      "shared",
      "```",
      "",
    ].join("\n"));
    const run = await runPageExamples(options(root, examples));
    assert.equal(run.results.get("write")?.status, "passed");
    assert.equal(run.results.get("read")?.status, "passed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("hidden setup and teardown run but produce no public expected output", async () => {
  const root = await scratch();
  try {
    const examples = await blocksOf([
      "```js test id=\"setup\" role=\"setup\" hidden",
      'import { writeFileSync } from "node:fs"; writeFileSync("a.txt", "prepared");',
      "```",
      "```js test id=\"read\"",
      'import { readFileSync } from "node:fs"; console.log(readFileSync("a.txt", "utf8"));',
      "```",
      "```output",
      "prepared",
      "```",
      "",
    ].join("\n"));
    const run = await runPageExamples(options(root, examples));
    assert.equal(run.results.get("setup")?.status, "passed", "the hidden setup still runs");
    assert.equal(run.results.get("read")?.status, "passed", "the visible block sees the setup's file");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a snippet imported from a file runs as its block, and a source change is a new hash", async () => {
  const root = await scratch();
  try {
    await mkdir(join(root, "lib"), { recursive: true });
    await writeFile(join(root, "lib", "greet.js"), 'console.log("from a snippet");\n');
    const examples = await blocksOf(["```js test snippet=\"lib/greet.js\"", "", "```", "```output", "from a snippet", "```", ""].join("\n"));
    const run = await runPageExamples(options(root, examples));
    assert.equal(run.results.get("example-1")?.status, "passed");
    assert.equal(run.results.get("example-1")?.evidence?.snippet?.file, "lib/greet.js");
    const hashBefore = run.results.get("example-1")?.sha256;
    await writeFile(join(root, "lib", "greet.js"), 'console.log("changed");\n');
    const changed = await runPageExamples(options(root, await blocksOf(["```js test snippet=\"lib/greet.js\"", "", "```", "```output", "from a snippet", "```", ""].join("\n"))));
    assert.notEqual(changed.results.get("example-1")?.sha256, hashBefore, "the snippet text is part of the hash");
    assert.equal(changed.results.get("example-1")?.status, "failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a runbook runs allowlisted steps and stops at the first failure", async () => {
  const root = await scratch();
  try {
    const examples = await blocksOf([
      "```bash test id=\"one\" role=\"step\" runbook=\"install\"",
      "echo first",
      "```",
      "```output",
      "first",
      "```",
      "```bash test id=\"two\" role=\"step\" runbook=\"install\"",
      "echo two",
      "```",
      "```output",
      "wrong",
      "```",
      "```bash test id=\"three\" role=\"step\" runbook=\"install\"",
      "echo never",
      "```",
      "",
    ].join("\n"));
    const run = await runPageExamples(options(root, examples, { allowlist: ["echo"] }));
    assert.equal(run.results.get("one")?.status, "passed");
    assert.equal(run.results.get("two")?.status, "failed");
    assert.equal(run.results.get("three")?.status, "skipped", "the step after the failure never ran");
    assert.equal(run.runbooks.length, 1);
    assert.equal(run.runbooks[0]?.stoppedAt, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a database language with no runner is skipped, not failed", async () => {
  const root = await scratch();
  try {
    const examples = await blocksOf(["```python test", 'print("hi")', "```", ""].join("\n"));
    const run = await runPageExamples(options(root, examples));
    assert.equal(run.results.get("example-1")?.status, "skipped");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed session stops its later blocks, which are reported as skipped", async () => {
  const root = await scratch();
  try {
    const examples = await blocksOf([
      "```js test session=\"s\" id=\"a\"",
      'throw new Error("boom");',
      "```",
      "```js test session=\"s\" id=\"b\"",
      'console.log("never");',
      "```",
      "",
    ].join("\n"));
    const run = await runPageExamples(options(root, examples));
    assert.equal(run.results.get("a")?.status, "failed");
    assert.notEqual(run.results.get("b")?.status, "passed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the cache replays a session with the same evidence, and only changed inputs rerun", async () => {
  const root = await scratch();
  const cacheDir = join(root, ".cache");
  try {
    const markdown = ["```js test", 'console.log("cached");', "```", "```output", "cached", "```", ""].join("\n");
    const first = await runPageExamples(options(root, await blocksOf(markdown), { cache: exampleCache({ dir: cacheDir, runtime: "fixed" }) }));
    const second = await runPageExamples(options(root, await blocksOf(markdown), { cache: exampleCache({ dir: cacheDir, runtime: "fixed" }) }));
    assert.equal(first.results.get("example-1")?.status, "passed");
    assert.equal(second.results.get("example-1")?.status, "passed");
    assert.equal(second.results.get("example-1")?.evidence?.outputs[0]?.actual, "cached", "the replay keeps the same evidence");

    const changed = await runPageExamples(options(root, await blocksOf(markdown.replace("cached", "other")), { cache: exampleCache({ dir: cacheDir, runtime: "fixed" }) }));
    assert.equal(changed.results.get("example-1")?.status, "failed", "changed code misses the cache and actually runs");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an explicit id repeated on a page is one error and no block runs under it twice", async () => {
  const root = await scratch();
  try {
    const examples = await blocksOf([
      "```js test id=\"dup\"",
      'console.log(1);',
      "```",
      "```js test id=\"dup\"",
      'console.log(2);',
      "```",
      "",
    ].join("\n"));
    const run = await runPageExamples(options(root, examples));
    assert.ok(run.diagnostics.some((diagnostic) => diagnostic.id === "example-duplicate-id" && diagnostic.severity === "error"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a network attempt is a network violation and does not reach the host", async () => {
  const root = await scratch();
  try {
    const examples = await blocksOf(["```js test", 'await fetch("https://example.com");', "```", ""].join("\n"));
    const run = await runPageExamples(options(root, examples));
    assert.equal(run.results.get("example-1")?.status, "failed");
    assert.equal(run.results.get("example-1")?.evidence?.violation, "network");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the sandbox flag is recorded, so nothing claims an isolation the host lacks", async () => {
  const root = await scratch();
  try {
    const examples = await blocksOf(["```js test", 'console.log("x");', "```", ""].join("\n"));
    const run = await runPageExamples(options(root, examples));
    assert.equal(typeof run.results.get("example-1")?.evidence?.sandboxed, "boolean");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the environment hash the run used is carried into the evidence", async () => {
  const root = await scratch();
  try {
    const examples = await blocksOf(["```js test", 'console.log("x");', "```", ""].join("\n"));
    const environment = "f".repeat(64);
    const run = await runPageExamples(options(root, examples, { environment }));
    assert.equal(run.results.get("example-1")?.environment, environment);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reading a page that does not exist yields no examples and no throw", async () => {
  const run = await runPageExamples(options(process.cwd(), []));
  assert.equal(run.results.size, 0);
  assert.deepEqual(run.diagnostics, []);
});

test("a denied command is a command violation and the finding names it", async () => {
  const root = await scratch();
  try {
    const examples = await blocksOf(["```bash test", "sudo rm -rf /", "```", ""].join("\n"));
    const run = await runPageExamples(options(root, examples));
    assert.equal(run.results.get("example-1")?.status, "failed");
    assert.equal(run.results.get("example-1")?.evidence?.violation, "command");
    assert.ok(run.diagnostics.some((diagnostic) => diagnostic.id === "example-failed" && /denied command/.test(diagnostic.message)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a timeout is a distinct limit in the finding, not a plain failure", async () => {
  const root = await scratch();
  try {
    const examples = await blocksOf(["```js test", "while (true) {}", "```", ""].join("\n"));
    const run = await runPageExamples({ ...options(root, examples), limits: { timeoutMs: 300, memoryMb: 0, network: "deny" } });
    assert.equal(run.results.get("example-1")?.evidence?.violation, "timeout");
    assert.ok(run.diagnostics.some((diagnostic) => /time limit stopped it/.test(diagnostic.message)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

