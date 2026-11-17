import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dataSnapshot } from "../src/cli/data.ts";
import { dataChanges } from "../src/data/changes/write.ts";

let clock = Date.UTC(2026, 0, 1) / 1000;

/** Every git call gets its own commit time, so two commits never share a snapshot date. */
function git(root: string, ...args: string[]): void {
  clock += 86_400;
  const date = `${clock} +0000`;
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args], {
    cwd: root,
    stdio: "ignore",
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
}

function rows(count: number, title = "T"): string {
  return Array.from({ length: count }, (_, i) => `- id: r${String(i).padStart(3, "0")}\n  title: ${title}${i}\n`).join("");
}

async function site(count: number, extra = ""): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "data-import-"));
  mkdirSync(join(root, "_data"));
  writeFileSync(join(root, "mizzen.yml"), `collections:\n  items:\n    source: _data/items.yml\n    changelog:\n      track: [title]\n${extra}`);
  writeFileSync(join(root, "_data", "items.yml"), rows(count));
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "data");
  await dataSnapshot({ root, name: "items" });
  return root;
}

const lines = (root: string) => readFileSync(join(root, "data-changes", "items.jsonl"), "utf8").trim().split("\n");

test("an empty history gets one imported event with the record count, not one added event per record", async () => {
  const root = await site(250);
  assert.equal((await dataChanges({ root, write: true })).code, 0);
  assert.equal(lines(root).length, 1);
  assert.match(lines(root)[0]!, /"type":"imported","record":"items","count":250/);
  assert.equal((await dataChanges({ root })).pending.length, 0, "the import is the recorded state");
});

test("a run over importThreshold is one imported event, and later events are normal", async () => {
  const root = await site(5, "      importThreshold: 3\n");
  await dataChanges({ root, write: true });
  writeFileSync(join(root, "_data", "items.yml"), rows(5, "X"));
  git(root, "commit", "-qam", "edit");
  await dataSnapshot({ root, name: "items" });
  const big = await dataChanges({ root, write: true });
  assert.deepEqual(big.pending.map((p) => [p.event.type, p.event.count]), [["imported", 5]]);

  writeFileSync(join(root, "_data", "items.yml"), rows(5, "X").replace("X0", "Y0"));
  git(root, "commit", "-qam", "edit again");
  await dataSnapshot({ root, name: "items" });
  const small = await dataChanges({ root, write: true });
  assert.deepEqual(small.pending.map((p) => [p.event.type, p.event.record, p.event.old, p.event.new]), [["changed", "r000", "X0", "Y0"]]);
  assert.equal(lines(root).length, 3);
});
