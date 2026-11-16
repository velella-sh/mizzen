import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { dataFetch, type FetchLike } from "../src/cli/data.ts";
import { readLock, sha256 } from "../src/data/lock.ts";
import { instantOfHttpDate, snapshotOfPinned } from "../src/data/snapshot.ts";

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "data-snapshot-sources-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const BODY = "- id: a\n";
const fetcher: FetchLike = async () =>
  new Response(BODY, { status: 200, headers: { "last-modified": "Sun, 01 Mar 2026 10:20:30 GMT", date: "Mon, 02 Mar 2026 00:00:00 GMT" } });

test("a package source records its name and exact version, with no date", () => {
  assert.deepEqual(
    snapshotOfPinned({ address: "npm:@acme/data/items.yml", packageName: "@acme/data", version: "2.3.4", sha256: sha256("x") }),
    { source: "npm:@acme/data/items.yml", ref: "@acme/data@2.3.4", tool: "npm" },
  );
});

test("a URL source records its hash and the date the lock stores", () => {
  const hash = sha256(BODY);
  assert.deepEqual(
    snapshotOfPinned({ address: "https://data.test/items.yml", sha256: hash, fetchedAt: "2026-03-01T10:20:30Z" }),
    { source: "https://data.test/items.yml", ref: `sha256:${hash}`, capturedAt: "2026-03-01T10:20:30Z", tool: "mizzen" },
  );
  assert.equal(snapshotOfPinned({ address: "https://data.test/items.yml", sha256: hash }).capturedAt, undefined);
  assert.equal(instantOfHttpDate("Sun, 01 Mar 2026 10:20:30 GMT"), "2026-03-01T10:20:30Z");
  assert.equal(instantOfHttpDate("nonsense"), undefined);
});

test("data fetch writes both snapshots from the response date and the installed package, and a second fetch changes nothing", async () => {
  const root = tree({
    "mizzen.yml":
      "collections:\n  remote:\n    source: https://data.test/items.yml\n  pkg:\n    source: npm:@acme/data/items.yml\n  local:\n    source: _data/local.yml\n",
    "_data/local.yml": "- id: a\n",
    "node_modules/@acme/data/package.json": JSON.stringify({ name: "@acme/data", version: "2.3.4" }),
    "node_modules/@acme/data/items.yml": BODY,
  });
  const first = await dataFetch({ root, fetch: fetcher });
  assert.equal(first.code, 0, first.errors.join("\n"));
  const lock = (await readLock(root)).lock;
  assert.deepEqual(lock.snapshots?.["remote"], {
    source: "https://data.test/items.yml",
    ref: `sha256:${sha256(BODY)}`,
    capturedAt: "2026-03-01T10:20:30Z",
    tool: "mizzen",
  });
  assert.equal(lock.snapshots?.["pkg"]?.ref, "@acme/data@2.3.4");
  assert.equal(lock.snapshots?.["local"], undefined);
  const text = readFileSync(join(root, "mizzen.lock.json"), "utf8");
  const again = await dataFetch({ root, fetch: async () => new Response(BODY, { headers: { "last-modified": "Tue, 03 Mar 2026 00:00:00 GMT" } }) });
  assert.equal(again.code, 0);
  assert.equal(readFileSync(join(root, "mizzen.lock.json"), "utf8"), text);
  assert.equal((await dataFetch({ root, fetch: fetcher, check: true })).code, 0);
});

test("a lock from 0.3.0 without snapshots still reads, and fetch adds them", async () => {
  const root = tree({
    "mizzen.yml": "collections:\n  pkg:\n    source: npm:@acme/data/items.yml\n",
    "node_modules/@acme/data/package.json": JSON.stringify({ name: "@acme/data", version: "2.3.4" }),
    "node_modules/@acme/data/items.yml": BODY,
    "mizzen.lock.json": `${JSON.stringify({ sources: { "npm:@acme/data/items.yml": { address: "npm:@acme/data/items.yml", bytes: BODY.length, sha256: sha256(BODY), version: "2.3.4" } }, version: 1 })}\n`,
  });
  const old = await readLock(root);
  assert.deepEqual(old.diagnostics, []);
  assert.equal(old.lock.snapshots, undefined);
  const result = await dataFetch({ root });
  assert.equal(result.code, 0);
  assert.equal((await readLock(root)).lock.snapshots?.["pkg"]?.ref, "@acme/data@2.3.4");
});
