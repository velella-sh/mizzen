/** `mizzen diff --base <ref>`: builds a git ref in a temporary worktree and leaves the repository as it found it. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli/index.ts";
import { diffAgainstRef } from "../src/diff/ref.ts";
import { DiffUsageError } from "../src/diff/index.ts";

const THEME = fileURLToPath(new URL("../../lateen", import.meta.url));
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });

function repo(): { top: string; site: string } {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "mizzen-diff-ref-")));
  const site = join(top, "docs");
  mkdirSync(site);
  git(top, "init", "-q", "-b", "main");
  writeFileSync(join(site, "a.md"), "---\ntitle: A\n---\n# A\n\nBody.\n");
  writeFileSync(join(site, "b.md"), "---\ntitle: B\n---\n# B\n\nBody.\n");
  git(top, "add", ".");
  git(top, "commit", "-q", "-m", "one");
  writeFileSync(join(site, "a.md"), "---\ntitle: A\n---\n# A\n\nBody changed.\n");
  rmSync(join(site, "b.md"));
  writeFileSync(join(site, "c.md"), "---\ntitle: C\n---\n# C\n");
  git(top, "add", ".");
  git(top, "commit", "-q", "-m", "two");
  return { top, site };
}

test("a ref is built and compared with the current site, and no worktree is left behind", async () => {
  const { top, site } = repo();
  try {
    const diff = await diffAgainstRef({ root: site, ref: "HEAD~1", themeRoot: THEME, defaultLayout: "doc" });
    assert.deepEqual(diff.pages.changed.map((p) => p.url), ["/a/"]);
    assert.deepEqual(diff.pages.removed.map((p) => p.url), ["/b/"]);
    assert.deepEqual(diff.pages.added.map((p) => p.url), ["/c/"]);
    assert.equal(git(top, "worktree", "list", "--porcelain").trim().split("\n").filter((l) => l.startsWith("worktree ")).length, 1);
    // The only thing a build adds to the site is its cache folder, as for any build.
    assert.equal(git(top, "status", "--porcelain").trim(), "?? docs/.mizzen/", "tracked files and the index are untouched");
    assert.equal(readFileSync(join(site, "a.md"), "utf8").includes("changed"), true);
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

test("an unknown ref is a usage error", async () => {
  const { top, site } = repo();
  try {
    await assert.rejects(diffAgainstRef({ root: site, ref: "no-such-ref", themeRoot: THEME }), DiffUsageError);
    await assert.rejects(diffAgainstRef({ root: site, ref: "--help", themeRoot: THEME }), DiffUsageError);
    const errors: string[] = [];
    const code = await main(["diff", "--base", "no-such-ref", site, "--theme", THEME], { error: (m) => errors.push(m), write: () => {}, log: () => {} });
    assert.equal(code, 2);
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});
