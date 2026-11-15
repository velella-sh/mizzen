import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isLock, lockText, readLock, sha256, storedPath, writeLock, type DataLock } from "../src/data/lock.ts";

function root(): string {
  return mkdtempSync(join(tmpdir(), "data-lock-"));
}

const LOCK: DataLock = {
  version: 1,
  sources: {
    "https://example.test/b.json": {
      address: "https://example.test/b.json",
      bytes: 2,
      sha256: sha256("b\n"),
    },
    "npm:pkg/a.yml": {
      address: "npm:pkg/a.yml",
      version: "1.0.0",
      bytes: 2,
      sha256: sha256("a\n"),
    },
  },
};

test("the lock text sorts keys at every level, ends in one LF, and holds no timestamp", () => {
  const text = lockText(LOCK);
  assert.ok(text.endsWith("\n"));
  assert.equal(text.split("\n").length, 2, "one trailing line feed, not a blank line");
  assert.ok(text.indexOf('"https://example.test/b.json"') < text.indexOf('"npm:pkg/a.yml"'));
  assert.doesNotMatch(text, /\d{4}-\d\d-\d\dT\d\d:/);
});

test("a written lock reads back equal, and a missing file is an empty lock", async () => {
  const dir = root();
  try {
    await writeLock(dir, LOCK);
    const read = await readLock(dir);
    assert.deepEqual(read.diagnostics, []);
    assert.deepEqual(read.lock, LOCK);

    const empty = root();
    try {
      assert.deepEqual((await readLock(empty)).lock, { version: 1, sources: {} });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a malformed lock is an error and yields an empty lock", async () => {
  const bad = root();
  try {
    writeFileSync(join(bad, "mizzen.lock.json"), "{ not json");
    const read = await readLock(bad);
    assert.deepEqual(read.lock, { version: 1, sources: {} });
    assert.equal(read.diagnostics[0]?.id, "data.lock-invalid");
    assert.equal(read.diagnostics[0]?.severity, "error");

    writeFileSync(
      join(bad, "mizzen.lock.json"),
      JSON.stringify({ version: 1, sources: { "https://example.test/a": { address: "https://example.test/a", bytes: 1, sha256: "not-a-hash" } } }),
    );
    const invalid = await readLock(bad);
    assert.equal(invalid.diagnostics[0]?.id, "data.lock-invalid");
  } finally {
    rmSync(bad, { recursive: true, force: true });
  }
});

test("the schema refuses an extra key, and stored bytes live under the hash", () => {
  assert.equal(isLock(LOCK), true);
  assert.equal(isLock({ version: 1, sources: { a: { address: "a", bytes: 1, sha256: sha256("x"), extra: true } } }), false);
  assert.match(storedPath("/site", "abc"), /\/site\/\.mizzen\/data\/abc$/);
  assert.equal(readFileSync(new URL("../schema/data-lock.schema.json", import.meta.url), "utf8").includes("sha256"), true);
});
