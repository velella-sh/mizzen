import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dataSnapshot } from "../src/cli/data.ts";
import { main } from "../src/cli/index.ts";

let clock = Date.UTC(2026, 5, 1) / 1000;
function git(root: string, ...args: string[]): void {
  clock += 86_400;
  const date = `${clock} +0000`;
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args], { cwd: root, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
}

async function run(root: string, ...extra: string[]): Promise<{ code: number; err: string }> {
  const err: string[] = [];
  const code = await main(["data", "changes", ...extra, "items", root, "--check"], { log: () => {}, error: (m: string) => void err.push(m) });
  return { code, err: err.join("\n") };
}

async function recorded(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "data-check-"));
  mkdirSync(join(root, "_data"));
  writeFileSync(join(root, "mizzen.yml"), "collections:\n  items:\n    source: _data/items.yml\n    changelog:\n      track: [title, price]\n      ignore: [price]\n");
  writeFileSync(join(root, "_data", "items.yml"), "- id: a\n  title: A\n  price: 1\n");
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "data");
  await dataSnapshot({ root, name: "items" });
  assert.equal(await main(["data", "changes", "items", root, "--write"], { log: () => {}, error: () => {} }), 0);
  return root;
}

async function edit(root: string, text: string): Promise<void> {
  writeFileSync(join(root, "_data", "items.yml"), text);
  git(root, "commit", "-qam", "edit");
  await dataSnapshot({ root, name: "items" });
}

test("clean data passes", async () => {
  assert.equal((await run(await recorded())).code, 0);
});

test("a pending change fails and names the event", async () => {
  const root = await recorded();
  await edit(root, "- id: a\n  title: B\n  price: 1\n");
  const result = await run(root);
  assert.equal(result.code, 1);
  assert.match(result.err, /pending items: changed Changed title of a/);
  assert.match(result.err, /without a history entry/);
});

test("a change to an ignored field does not fail", async () => {
  const root = await recorded();
  await edit(root, "- id: a\n  title: A\n  price: 2\n");
  assert.equal((await run(root)).code, 0);
});
