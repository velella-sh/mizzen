import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isReviewDate, isReviewLock, readReviewLock, reviewDate, reviewLockText, withPage, writeReviewLock, emptyReviewLock, REVIEW_LOCK_FILE } from "../src/stale/lock.ts";

const H = "a".repeat(64);
const dir = () => mkdtempSync(join(tmpdir(), "stale-lock-"));

test("a lock validates and the same input writes the same file", async () => {
  const lock = withPage(withPage(emptyReviewLock(), "b.md", { reviewed: "2026-01-02", files: [{ path: "z.ts", sha256: H }, { path: "a.ts", sha256: H }] }), "a.md", { reviewed: "2026-01-01", files: [] });
  const text = reviewLockText(lock);
  assert.equal(isReviewLock(JSON.parse(text)), true);
  assert.equal(text, reviewLockText(JSON.parse(text)));
  assert.ok(text.indexOf('"a.md"') < text.indexOf('"b.md"'));
  assert.ok(text.indexOf('"a.ts"') < text.indexOf('"z.ts"'));
  assert.equal(text.endsWith("}\n"), true);
  const root = dir();
  await writeReviewLock(root, lock);
  assert.equal(readFileSync(join(root, REVIEW_LOCK_FILE), "utf8"), text);
  assert.deepEqual((await readReviewLock(root)).lock, JSON.parse(text));
});

test("a missing lock is empty and a malformed one is an error", async () => {
  const root = dir();
  assert.deepEqual(await readReviewLock(root), { lock: emptyReviewLock(), diagnostics: [] });
  writeFileSync(join(root, REVIEW_LOCK_FILE), "{");
  assert.equal((await readReviewLock(root)).diagnostics[0]?.id, "stale.lock-invalid");
  writeFileSync(join(root, REVIEW_LOCK_FILE), '{"version":1,"pages":{"a.md":{"reviewed":"yesterday","files":[]}}}');
  assert.equal((await readReviewLock(root)).diagnostics[0]?.id, "stale.lock-invalid");
});

test("the date is --date or the HEAD commit date, never the clock", async () => {
  assert.deepEqual(await reviewDate(dir(), "2026-02-03"), { date: "2026-02-03" });
  assert.ok("error" in (await reviewDate(dir(), "2026-02-30")));
  assert.ok("error" in (await reviewDate(dir())));
  const root = dir();
  const env = { ...process.env, GIT_AUTHOR_DATE: "2020-05-06T12:00:00Z", GIT_COMMITTER_DATE: "2020-05-06T12:00:00Z", GIT_CONFIG_GLOBAL: "/dev/null", TZ: "UTC" };
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { env });
  git("init", "-q");
  git("commit", "-q", "--allow-empty", "-m", "x");
  assert.deepEqual(await reviewDate(root), { date: "2020-05-06" });
  assert.equal(isReviewDate("2026-13-01"), false);
});
