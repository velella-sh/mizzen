import assert from "node:assert/strict";
import { test } from "node:test";
import { isLock, lockText, type DataLock } from "../src/data/lock.ts";
import { isCapturedAt, orderedSnapshot, snapshotProblems } from "../src/data/snapshot.ts";

const SHA = "a".repeat(64);

test("a snapshot needs only a source", () => {
  assert.deepEqual(snapshotProblems({ source: "_data/items.yml" }), []);
  assert.deepEqual(snapshotProblems({ source: "_data/items.yml", ref: "abc", capturedAt: "2026-03-01", tool: "git", toolVersion: "2.45.0" }), []);
  assert.notDeepEqual(snapshotProblems({ ref: "abc" }), []);
  assert.notDeepEqual(snapshotProblems({ source: "x", extra: 1 }), []);
});

test("capturedAt takes a date or an instant to the second, and refuses a clock reading", () => {
  assert.equal(isCapturedAt("2026-03-01"), true);
  assert.equal(isCapturedAt("2026-03-01T10:20:30Z"), true);
  assert.equal(isCapturedAt("2026-02-30"), false);
  assert.equal(isCapturedAt(new Date().toISOString()), false);
  assert.equal(isCapturedAt("2026-03-01T10:20:30+02:00"), false);
  assert.notDeepEqual(snapshotProblems({ source: "x", capturedAt: new Date().toISOString() }), []);
});

test("the lock schema accepts a snapshot and rejects a build-time date", () => {
  const lock = { version: 1, sources: {}, snapshots: { items: { source: "_data/items.yml", capturedAt: "2026-03-01" } } };
  assert.equal(isLock(lock), true);
  assert.equal(isLock({ ...lock, snapshots: { items: { source: "x", capturedAt: new Date().toISOString() } } }), false);
  assert.equal(isLock({ ...lock, snapshots: { items: { ref: "abc" } } }), false);
  assert.equal(isLock({ version: 1, sources: { a: { address: "a", bytes: 1, sha256: SHA } } }), true);
});

test("a lock without snapshots keeps its bytes, and snapshot fields are written in a stable order", () => {
  const bare: DataLock = { version: 1, sources: {} };
  assert.equal(lockText(bare), '{"sources":{},"version":1}\n');
  const a = lockText({ version: 1, sources: {}, snapshots: { b: { toolVersion: "1", tool: "git", capturedAt: "2026-01-01", ref: "r", source: "s" }, a: { source: "s" } } });
  assert.equal(
    a,
    '{"snapshots":{"a":{"source":"s"},"b":{"capturedAt":"2026-01-01","ref":"r","source":"s","tool":"git","toolVersion":"1"}},"sources":{},"version":1}\n',
  );
  assert.deepEqual(Object.keys(orderedSnapshot({ toolVersion: "1", source: "s", ref: "r" })), ["source", "ref", "toolVersion"]);
});

test("a collection carries the lock's snapshot, and a site without one is unchanged", async () => {
  const { mkdirSync, mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { loadConfig } = await import("../src/config/load.ts");
  const { loadCollections } = await import("../src/data/collections.ts");
  const root = mkdtempSync(join(tmpdir(), "data-snapshot-load-"));
  mkdirSync(join(root, "_data"));
  writeFileSync(join(root, "mizzen.yml"), "collections:\n  items:\n    source: _data/items.yml\n");
  writeFileSync(join(root, "_data", "items.yml"), "- id: a\n");
  const config = loadConfig(root).config;
  const bare = await loadCollections({ root, config });
  assert.equal("snapshot" in bare.collections["items"]!, false);
  writeFileSync(join(root, "mizzen.lock.json"), '{"snapshots":{"items":{"capturedAt":"2026-03-01","source":"_data/items.yml"}},"sources":{},"version":1}\n');
  const withSnapshot = await loadCollections({ root, config });
  assert.deepEqual(withSnapshot.collections["items"]?.snapshot, { source: "_data/items.yml", capturedAt: "2026-03-01" });
});
