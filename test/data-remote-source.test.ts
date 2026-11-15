import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { DEFAULT_DATA_LIMITS } from "../src/data/limits.ts";
import { sha256, storedPath, writeLock, type DataLock } from "../src/data/lock.ts";
import { readRemoteSource } from "../src/data/remote-source.ts";

const BYTES = "id,name\n1,Alpha\n";

function site(): string {
  return mkdtempSync(join(tmpdir(), "data-remote-"));
}

function pin(root: string, store = true): DataLock {
  const hash = sha256(BYTES);
  if (store) {
    const path = storedPath(root, hash);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, BYTES);
  }
  return {
    version: 1,
    sources: {
      "https://example.test/items.csv": { address: "https://example.test/items.csv", bytes: BYTES.length, sha256: hash },
    },
  };
}

test("a pinned https source reads its stored bytes and never opens a request", async () => {
  const root = site();
  const original = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("a build must not fetch");
  }) as typeof fetch;
  try {
    const lock = pin(root);
    await writeLock(root, lock);
    const result = await readRemoteSource(root, "https://example.test/items.csv", lock, DEFAULT_DATA_LIMITS);
    assert.equal(result.diagnostic, undefined);
    assert.equal(result.source?.text, BYTES);
    assert.equal(result.source?.display, `.mizzen/data/${sha256(BYTES)}`);
  } finally {
    globalThis.fetch = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing lock entry, a missing store, and a changed store each fail with one diagnostic", async () => {
  const root = site();
  try {
    const missing = await readRemoteSource(root, "https://example.test/items.csv", { version: 1, sources: {} }, DEFAULT_DATA_LIMITS);
    assert.equal(missing.diagnostic?.id, "data.lock-missing");

    const lock = pin(root, false);
    await writeLock(root, lock);
    const store = await readRemoteSource(root, "https://example.test/items.csv", lock, DEFAULT_DATA_LIMITS);
    assert.equal(store.diagnostic?.id, "data.store-missing");

    const path = storedPath(root, lock.sources["https://example.test/items.csv"]!.sha256);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "changed\n");
    const changed = await readRemoteSource(root, "https://example.test/items.csv", lock, DEFAULT_DATA_LIMITS);
    assert.equal(changed.diagnostic?.id, "data.store-mismatch");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a build refuses http and a source over its limit before reading it", async () => {
  const root = site();
  try {
    const http = await readRemoteSource(root, "http://example.test/items.csv", { version: 1, sources: {} }, DEFAULT_DATA_LIMITS);
    assert.equal(http.diagnostic?.id, "data.source-scheme");

    const lock = pin(root);
    const tooLarge = await readRemoteSource(root, "https://example.test/items.csv", lock, {
      ...DEFAULT_DATA_LIMITS,
      bytes: 2,
    });
    assert.equal(tooLarge.diagnostic?.id, "data.source-too-large");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
