import assert from "node:assert/strict";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { hashContent, hashFiles } from "../src/stale/hash.ts";

const dir = () => mkdtempSync(join(tmpdir(), "stale-hash-"));

test("line endings do not change the hash", () => {
  assert.equal(hashContent(Buffer.from("a\r\nb\r\n")), hashContent(Buffer.from("a\nb\n")));
  assert.match(hashContent(Buffer.from("a")), /^[0-9a-f]{64}$/);
});

test("a one-byte edit changes the hash", () => {
  assert.notEqual(hashContent(Buffer.from("abc")), hashContent(Buffer.from("abd")));
});

test("binary content is hashed as it is", () => {
  assert.notEqual(hashContent(Buffer.from([0, 13, 10])), hashContent(Buffer.from([0, 10])));
});

test("files come back sorted and the modification time is ignored", async () => {
  const root = dir();
  writeFileSync(join(root, "b.ts"), "b");
  writeFileSync(join(root, "a.ts"), "a");
  const one = await hashFiles(["b.ts", "a.ts", "a.ts"], { root, file: "p.md" });
  utimesSync(join(root, "a.ts"), 1, 1);
  const two = await hashFiles(["a.ts", "b.ts"], { root, file: "p.md" });
  assert.deepEqual(one.hashes.map((h) => h.path), ["a.ts", "b.ts"]);
  assert.deepEqual(one.hashes, two.hashes);
});

test("the file and size bounds are reported", async () => {
  const root = dir();
  writeFileSync(join(root, "a.ts"), "aaaa");
  writeFileSync(join(root, "b.ts"), "b");
  const size = await hashFiles(["a.ts", "b.ts"], { root, file: "p.md", maxBytes: 2 });
  assert.deepEqual(size.hashes.map((h) => h.path), ["b.ts"]);
  assert.equal(size.diagnostics[0]?.id, "stale.covers-limit");
  const count = await hashFiles(["a.ts", "b.ts"], { root, file: "p.md", maxFiles: 1 });
  assert.equal(count.hashes.length, 1);
  assert.equal(count.diagnostics[0]?.id, "stale.covers-limit");
});

test("a missing file is reported, not thrown", async () => {
  const r = await hashFiles(["nope.ts"], { root: dir(), file: "p.md" });
  assert.equal(r.diagnostics[0]?.id, "stale.covers-unreadable");
});
