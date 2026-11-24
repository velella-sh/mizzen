/**
 * The `examples` CLI: `lock` records the environment manifest, `record` runs the opt-in fences and writes
 * `.mizzen-examples.json` with evidence and provenance (#1326, #1328, #1336).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main } from "../src/cli/index.ts";

const COMMIT = "a".repeat(40);
const DATE = "2026-11-23";

/** A temporary site with one opt-in example, removed by the caller. */
function site(config: string, markdown: string): string {
  const root = mkdtempSync(join(tmpdir(), "examples-cli-"));
  writeFileSync(join(root, "mizzen.yml"), config);
  writeFileSync(join(root, "guide.md"), markdown);
  mkdirSync(join(root, "fixtures", "a"), { recursive: true });
  writeFileSync(join(root, "fixtures", "a", "input.txt"), "hello\n");
  return root;
}

/** Runs the CLI quietly. */
async function run(args: readonly string[]): Promise<number> {
  return main(args, { log: () => {}, error: () => {} });
}

const EXECUTE = "title: Examples\nexamples:\n  execute: true\n  lock: false\n  timeoutMs: 15000\n";
const MARKDOWN = ["# Guide", "", "```js test id=\"hello\"", 'console.log("hi");', "```", "```output", "hi", "```", ""].join("\n");

test("examples lock writes a version 1 environment manifest and a second call checks it", async () => {
  const root = site(EXECUTE, MARKDOWN);
  try {
    assert.equal(await run(["examples", "lock", root]), 0);
    const manifest = JSON.parse(readFileSync(join(root, ".mizzen-env.json"), "utf8")) as { version: number; runtime: { node: string }; fixtures: unknown[] };
    assert.equal(manifest.version, 1);
    assert.match(manifest.runtime.node, /^v\d+\./);
    assert.equal(manifest.fixtures.length, 1, "the fixture folder is hashed into the lock");

    assert.equal(await run(["examples", "lock", root, "--check"]), 0, "an unchanged host matches");

    const changed = JSON.parse(readFileSync(join(root, ".mizzen-env.json"), "utf8")) as { runtime: { node: string } };
    changed.runtime.node = "v0.0.0";
    writeFileSync(join(root, ".mizzen-env.json"), `${JSON.stringify(changed, null, 2)}\n`);
    assert.equal(await run(["examples", "lock", root, "--check"]), 1, "a changed host is refused");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("examples record runs the opt-in fences and writes the lock with evidence and provenance", async () => {
  const root = site(EXECUTE, MARKDOWN);
  try {
    assert.equal(await run(["examples", "record", root, "--date", DATE, "--commit", COMMIT]), 0);
    const lock = JSON.parse(readFileSync(join(root, ".mizzen-examples.json"), "utf8")) as {
      version: number;
      examples: Record<string, Record<string, { status: string; date: string; commit: string; exitCode: number | null; evidence?: { outputs: unknown[] } }>>;
    };
    assert.equal(lock.version, 1);
    const entry = lock.examples["/guide/"]!.hello!;
    assert.equal(entry.status, "passed");
    assert.equal(entry.date, DATE);
    assert.equal(entry.commit, COMMIT);
    assert.equal(entry.exitCode, 0);
    assert.ok(entry.evidence && entry.evidence.outputs.length > 0, "the run's output comparison is evidence");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("examples record fails when a fence fails", async () => {
  const root = site(EXECUTE, MARKDOWN.replace("```output\nhi\n```", "```output\nwrong\n```"));
  try {
    assert.equal(await run(["examples", "record", root, "--date", DATE, "--commit", COMMIT]), 1);
    const lock = JSON.parse(readFileSync(join(root, ".mizzen-examples.json"), "utf8")) as { examples: Record<string, Record<string, { status: string }>> };
    assert.equal(lock.examples["/guide/"]!.hello!.status, "failed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("examples record enforces the lock by default and --no-lock skips it", async () => {
  const root = site(EXECUTE.replace("lock: false", "lock: true"), MARKDOWN);
  try {
    assert.equal(await run(["examples", "record", root, "--date", DATE, "--commit", COMMIT]), 1, "no lock is an error");
    assert.equal(await run(["examples", "record", root, "--date", DATE, "--commit", COMMIT, "--no-lock"]), 0, "--no-lock skips the check");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("examples record needs a date and a full commit", async () => {
  const root = site(EXECUTE, MARKDOWN);
  try {
    assert.equal(await run(["examples", "record", root, "--date", DATE]), 2, "a missing --commit is a usage error");
    assert.equal(await run(["examples", "record", root, "--commit", COMMIT]), 2, "a missing --date is a usage error");
    assert.equal(await run(["examples", "record", root, "--date", "2026-13-01", "--commit", COMMIT]), 2, "an invalid date is refused");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unknown examples subcommand is a usage error", async () => {
  assert.equal(await run(["examples", "unknown"]), 2);
});

