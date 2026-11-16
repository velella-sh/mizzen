import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dataSnapshot } from "../src/cli/data.ts";
import { main, parseArgs } from "../src/cli/index.ts";
import { readLock } from "../src/data/lock.ts";

const CONFIG = "title: T\ncollections:\n  items:\n    source: _data/items.yml\n  remote:\n    source: https://example.com/x.json\n";

function site(): string {
  const root = mkdtempSync(join(tmpdir(), "data-snapshot-git-"));
  mkdirSync(join(root, "_data"));
  writeFileSync(join(root, "mizzen.yml"), CONFIG);
  writeFileSync(join(root, "_data", "items.yml"), "- id: a\n");
  return root;
}

function git(root: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args], {
    cwd: root,
    stdio: "ignore",
    env: { ...process.env, GIT_COMMITTER_DATE: "2026-03-01T10:20:30Z", GIT_AUTHOR_DATE: "2026-03-01T10:20:30Z" },
  });
}

function commitAll(root: string): void {
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "data");
}

test("a clean tree records the last commit and its date, not the clock", async () => {
  const root = site();
  commitAll(root);
  const result = await dataSnapshot({ root, name: "items" });
  assert.equal(result.code, 0, result.errors.join("\n"));
  const snapshot = (await readLock(root)).lock.snapshots?.["items"];
  assert.equal(snapshot?.source, "_data/items.yml");
  assert.match(snapshot?.ref ?? "", /^[0-9a-f]{40}$/);
  assert.equal(snapshot?.capturedAt, "2026-03-01T10:20:30Z");
  assert.equal(snapshot?.tool, "git");
  const again = await dataSnapshot({ root, name: "items" });
  assert.equal(again.code, 0);
  const text = readFileSync(join(root, "mizzen.lock.json"), "utf8");
  await dataSnapshot({ root, name: "items" });
  assert.equal(readFileSync(join(root, "mizzen.lock.json"), "utf8"), text);
});

test("a dirty tree is refused unless --allow-dirty", async () => {
  const root = site();
  commitAll(root);
  writeFileSync(join(root, "_data", "items.yml"), "- id: b\n");
  const refused = await dataSnapshot({ root, name: "items" });
  assert.equal(refused.code, 1);
  assert.match(refused.errors.join(""), /uncommitted changes/);
  assert.equal((await readLock(root)).lock.snapshots, undefined);
  const allowed = await dataSnapshot({ root, name: "items", allowDirty: true });
  assert.equal(allowed.code, 0);
  assert.match(allowed.messages.join("\n"), /uncommitted/);
  assert.match((await readLock(root)).lock.snapshots?.["items"]?.ref ?? "", /^[0-9a-f]{40}$/);
});

test("a folder that is not a repository, an uncommitted file, and a remote source are refused", async () => {
  const root = site();
  const outside = await dataSnapshot({ root, name: "items" });
  assert.equal(outside.code, 1);
  assert.match(outside.errors.join(""), /not inside a git repository/);
  git(root, "init", "-q");
  const none = await dataSnapshot({ root, name: "items", allowDirty: true });
  assert.equal(none.code, 1);
  assert.match(none.errors.join(""), /no commit yet/);
  assert.equal((await dataSnapshot({ root, name: "remote" })).code, 2);
  assert.equal((await dataSnapshot({ root, name: "missing" })).code, 2);
});

test("the command parses and runs", async () => {
  assert.deepEqual(parseArgs(["data", "snapshot", "items", "site", "--allow-dirty"]), {
    options: { command: "data-snapshot", root: "site", name: "items", allowDirty: true },
  });
  assert.ok("error" in parseArgs(["data", "snapshot"]));
  const root = site();
  commitAll(root);
  const logs: string[] = [];
  const code = await main(["data", "snapshot", "items", root], { log: (m: string) => void logs.push(m), error: () => {} });
  assert.equal(code, 0);
  assert.match(logs.join("\n"), /snapshot items at/);
});
