/**
 * Executable documentation and examples, end to end (#1314, #1325 – #1336): a fixture site runs its fences offline
 * through the installed CLI and tarball, a failing example is reported, and correcting it makes the same run pass.
 *
 * The whole path is exercised from the public entry: the fence syntax, the environment lock, type-checking, the bounded
 * runner, stdout and stderr comparison, shared sessions, hidden setup and teardown, the runbook, limits, the cache, and
 * the result in `examples.json` and each page's `index.json`.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = join(ROOT, "fixtures", "executable-examples");
const THEME = join(ROOT, "..", "lateen");
const BIN = join(ROOT, "bin", "mizzen.ts");

/** Runs the CLI, returning its status and output. */
function mizzen(args: readonly string[], cwd: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8" });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/** A copy of the fixture in a temporary folder, removed by the caller. */
function copyFixture(): string {
  const parent = mkdtempSync(join(tmpdir(), "executable-examples-"));
  const site = join(parent, "site");
  cpSync(FIXTURE, site, { recursive: true });
  // The committed fixture is the failing state; a fresh copy must not inherit a stale cache or lock.
  rmSync(join(site, ".mizzen"), { recursive: true, force: true });
  rmSync(join(site, ".mizzen-examples.json"), { force: true });
  return parent;
}

/** Builds the site into `out` through the CLI, returning the diagnostics text. */
function build(site: string, out: string): { status: number; text: string } {
  const result = mizzen(["build", site, "--out", out, "--theme", THEME], join(site, ".."));
  return { status: result.status, text: `${result.stdout}${result.stderr}` };
}

test("the installed fixture records every block: sessions, hidden setup, snippets, and the runbook all pass", { skip: !existsSync(THEME) }, () => {
  const parent = copyFixture();
  const site = join(parent, "site");
  const out = join(parent, "out");
  try {
    // Correct the one intended failure first, so the whole page is green and the totals are exact.
    const guide = readFileSync(join(site, "guide.md"), "utf8").replace("```output\ngoodbye\n```", "```output\nhello\n```");
    writeFileSync(join(site, "guide.md"), guide);
    const { status, text } = build(site, out);
    assert.equal(status, 0, text);

    const report = JSON.parse(readFileSync(join(out, "examples.json"), "utf8")) as {
      pages: Array<{ url: string; total: number; passed: number; failed: number; skipped: number }>;
      version: number;
      examples: Record<string, Record<string, { status: string; evidence?: { session?: string; outputs?: Array<{ stream: string; ok: boolean }> } }>>;
    };
    assert.equal(report.version, 1);
    assert.deepEqual(report.pages, [{ url: "/guide/", total: 9, passed: 9, failed: 0, skipped: 0 }]);
    const entries = report.examples["/guide/"]!;
    for (const id of ["greet", "passes", "snippet", "setup", "read", "write", "read-state", "one", "two"]) {
      assert.equal(entries[id]?.status, "passed", `${id} passed`);
    }
    assert.equal(entries["read-state"]?.evidence?.session, "run", "the shared session is recorded");
    assert.equal(entries.one?.evidence?.session, "checks", "the runbook is recorded");

    // The page JSON carries the same evidence, keyed by fence id.
    const page = JSON.parse(readFileSync(join(out, "guide", "index.json"), "utf8")) as { examples?: Record<string, { status: string }> };
    assert.equal(page.examples?.greet?.status, "passed");
    assert.equal(page.examples?.["read-state"]?.status, "passed");

    // The hidden setup block is absent from the HTML but kept, with its `hidden` marker, in the Markdown twin.
    const html = readFileSync(join(out, "guide", "index.html"), "utf8");
    assert.doesNotMatch(html, /data-example-id="setup"/, "the hidden setup block is not public text");
    assert.match(html, /data-example-id="read"/, "the visible block that reads the setup's file is public");
    const twin = readFileSync(join(out, "guide", "index.md"), "utf8");
    assert.match(twin, /role="setup" hidden/, "the Markdown twin keeps the hidden contract");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a failing example is reported at its fence and a corrected run passes", { skip: !existsSync(THEME) }, () => {
  const parent = copyFixture();
  const site = join(parent, "site");
  const failing = join(parent, "failing");
  const fixed = join(parent, "fixed");
  try {
    // The committed state: `greet` prints `hello` but expects `goodbye`, so `failOnFailure` makes it an error.
    const first = build(site, failing);
    assert.equal(first.status, 1, first.text);
    assert.match(first.text, /example-failed/);
    assert.match(first.text, /greet/);
    const failingReport = JSON.parse(readFileSync(join(failing, "examples.json"), "utf8")) as { examples: Record<string, Record<string, { status: string }>> };
    assert.equal(failingReport.examples["/guide/"]!.greet?.status, "failed");

    // Correct the expected output only; the same run now passes.
    const guide = readFileSync(join(site, "guide.md"), "utf8").replace("```output\ngoodbye\n```", "```output\nhello\n```");
    writeFileSync(join(site, "guide.md"), guide);
    const second = build(site, fixed);
    assert.equal(second.status, 0, second.text);
    const fixedReport = JSON.parse(readFileSync(join(fixed, "examples.json"), "utf8")) as { examples: Record<string, Record<string, { status: string }>> };
    assert.equal(fixedReport.examples["/guide/"]!.greet?.status, "passed");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a missing environment lock stops an opt-in run with one explicit finding", { skip: !existsSync(THEME) }, () => {
  const parent = copyFixture();
  const site = join(parent, "site");
  const out = join(parent, "out");
  try {
    // Turn the lock on without preparing one.
    writeFileSync(
      join(site, "mizzen.yml"),
      readFileSync(join(site, "mizzen.yml"), "utf8").replace("lock: false", "lock: true"),
    );
    const { status, text } = build(site, out);
    assert.equal(status, 1, text);
    assert.match(text, /example-unlocked/);
    assert.match(text, /\.mizzen-env\.json/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a prepared lock lets the run proceed, and a changed host is refused", { skip: !existsSync(THEME) }, () => {
  const parent = copyFixture();
  const site = join(parent, "site");
  const out = join(parent, "out");
  try {
    writeFileSync(
      join(site, "mizzen.yml"),
      readFileSync(join(site, "mizzen.yml"), "utf8").replace("lock: false", "lock: true"),
    );
    const locked = mizzen(["examples", "lock", site], site);
    assert.equal(locked.status, 0, `${locked.stdout}${locked.stderr}`);
    assert.ok(existsSync(join(site, ".mizzen-env.json")));

    // Correct the intended failure so only the lock decides the outcome.
    writeFileSync(join(site, "guide.md"), readFileSync(join(site, "guide.md"), "utf8").replace("```output\ngoodbye\n```", "```output\nhello\n```"));
    const ok = build(site, out);
    assert.equal(ok.status, 0, ok.text);

    // A host that reports a different Node is a changed environment.
    const host = JSON.parse(readFileSync(join(site, ".mizzen-env.json"), "utf8")) as { runtime: { node: string } };
    host.runtime.node = "v0.0.0";
    writeFileSync(join(site, ".mizzen-env.json"), `${JSON.stringify(host, null, 2)}\n`);
    const changed = build(site, join(parent, "out2"));
    assert.equal(changed.status, 1, changed.text);
    assert.match(changed.text, /example-unlocked/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
