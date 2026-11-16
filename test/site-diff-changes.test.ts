import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dataSnapshot } from "../src/cli/data.ts";
import { dataChanges } from "../src/data/changes/write.ts";
import { pendingChanges } from "../src/diff/changes.ts";
import { formatMarkdown, formatText } from "../src/diff/format.ts";
import type { SiteDiff } from "../src/diff/types.ts";

let clock = Date.UTC(2026, 8, 1) / 1000;
function git(root: string, ...args: string[]): void {
  clock += 86_400;
  const date = `${clock} +0000`;
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args], { cwd: root, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
}

const EMPTY: SiteDiff = {
  version: 1,
  base: { hash: "a".repeat(64) },
  head: { hash: "b".repeat(64) },
  identical: false,
  summary: { pages: { added: 0, removed: 0, changed: 0, moved: 0 }, files: { added: 0, removed: 0, changed: 0 }, records: { added: 0, removed: 0, changed: 0 }, brokenUrls: 0, renderOnly: 0 },
  pages: { added: [], removed: [], changed: [], moved: [] },
  brokenUrls: [],
  files: { added: [], removed: [], changed: [] },
  records: [],
};

test("a data change is a pending entry in the report, and the diff writes nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "diff-changes-"));
  mkdirSync(join(root, "_data"));
  writeFileSync(join(root, "mizzen.yml"), "collections:\n  items:\n    source: _data/items.yml\n    changelog:\n      track: [title]\n      labels:\n        changed: \"{title} now reads {new}\"\n");
  writeFileSync(join(root, "_data", "items.yml"), "- id: a\n  title: A\n");
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "data");
  await dataSnapshot({ root, name: "items" });
  await dataChanges({ root, write: true });
  writeFileSync(join(root, "_data", "items.yml"), "- id: a\n  title: B\n");
  git(root, "commit", "-qam", "edit");
  await dataSnapshot({ root, name: "items" });
  const before = readFileSync(join(root, "data-changes", "items.jsonl"), "utf8");

  const changes = await pendingChanges(root);
  assert.equal(changes.length, 1);
  assert.equal(changes[0]!.collection, "items");
  assert.equal(changes[0]!.events[0]!.summary, "B now reads B");
  assert.equal(readFileSync(join(root, "data-changes", "items.jsonl"), "utf8"), before);

  const md = formatMarkdown({ ...EMPTY, changes });
  assert.match(md, /#### Pending history entries/);
  assert.match(md, /\*\*items\*\*\n\n- changed: B now reads B/);
  assert.match(formatText({ ...EMPTY, changes }), /Pending history entries:\n  items: changed B now reads B/);
});

test("without a changelog, or without pending entries, the report has no section", async () => {
  assert.doesNotMatch(formatMarkdown(EMPTY), /Pending history/);
  const root = mkdtempSync(join(tmpdir(), "diff-nochanges-"));
  writeFileSync(join(root, "mizzen.yml"), "title: x\n");
  assert.deepEqual(await pendingChanges(root), []);
  assert.equal(existsSync(join(root, "data-changes")), false);
});
