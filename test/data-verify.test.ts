import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dataSnapshot } from "../src/cli/data.ts";
import { main, parseArgs } from "../src/cli/index.ts";
import { verifyData } from "../src/data/verify.ts";

function git(root: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args], { cwd: root, stdio: "ignore" });
}

async function recorded(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "data-verify-"));
  mkdirSync(join(root, "_data"));
  writeFileSync(join(root, "mizzen.yml"), "collections:\n  items:\n    source: _data/items.yml\n");
  writeFileSync(join(root, "_data", "items.yml"), "- id: a\n  title: A\n- id: b\n  title: B\n");
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "data");
  assert.equal((await dataSnapshot({ root, name: "items" })).code, 0);
  return root;
}

test("equal data verifies, and verify never writes the lock", async () => {
  const root = await recorded();
  const lock = readFileSync(join(root, "mizzen.lock.json"), "utf8");
  const result = await verifyData({ root });
  assert.equal(result.code, 0, result.errors.join("\n"));
  assert.deepEqual(result.messages, ["ok items"]);
  assert.equal(readFileSync(join(root, "mizzen.lock.json"), "utf8"), lock);
});

test("a changed record is named with its source position, and the exit code is non-zero", async () => {
  const root = await recorded();
  writeFileSync(join(root, "_data", "items.yml"), "- id: a\n  title: A\n- id: b\n  title: Changed\n");
  const result = await verifyData({ root });
  assert.equal(result.code, 1);
  assert.match(result.errors[0]!, /record "b" changed at _data\/items\.yml:3:3/);
  const lines: string[] = [];
  const code = await main(["data", "verify", root], { log: () => {}, error: (m: string) => void lines.push(m) });
  assert.equal(code, 1);
  assert.match(lines.join("\n"), /changed at/);
});

test("a removed record and a removed file are differences, and a collection without a snapshot is skipped", async () => {
  const root = await recorded();
  writeFileSync(join(root, "_data", "items.yml"), "- id: a\n  title: A\n");
  assert.match((await verifyData({ root })).errors[0]!, /record "b" was removed/);
  rmSync(join(root, "_data", "items.yml"));
  const gone = await verifyData({ root });
  assert.equal(gone.code, 1);
  assert.match(gone.errors[0]!, /was removed/);
  rmSync(join(root, "mizzen.lock.json"));
  const none = await verifyData({ root });
  assert.equal(none.code, 0);
  assert.match(none.messages[0]!, /skipped items/);
});

test("a package whose file changed no longer matches its lock entry", async () => {
  const { dataFetch } = await import("../src/cli/data.ts");
  const root = mkdtempSync(join(tmpdir(), "data-verify-pkg-"));
  mkdirSync(join(root, "node_modules/pkg"), { recursive: true });
  writeFileSync(join(root, "node_modules/pkg/package.json"), '{"name":"pkg","version":"1.0.0"}');
  writeFileSync(join(root, "node_modules/pkg/items.yml"), "- id: a\n");
  writeFileSync(join(root, "mizzen.yml"), "collections:\n  items:\n    source: npm:pkg/items.yml\n");
  assert.equal((await dataFetch({ root })).code, 0);
  assert.equal((await verifyData({ root })).code, 0);
  writeFileSync(join(root, "node_modules/pkg/items.yml"), "- id: b\n");
  const result = await verifyData({ root });
  assert.equal(result.code, 1);
  assert.match(result.errors[0]!, /content hash/);
});

test("the command parses", () => {
  assert.deepEqual(parseArgs(["data", "verify", "site"]), { options: { command: "data-verify", root: "site" } });
});
