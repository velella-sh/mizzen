import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { dataFetch, dataSnapshot } from "../src/cli/data.ts";
import { loadConfig } from "../src/config/load.ts";
import { isLock, lockText, readLock, sha256 } from "../src/data/lock.ts";
import { compileSchemas } from "../src/data/schema.ts";
import { snapshotProblems } from "../src/data/snapshot.ts";

const SCHEMA = JSON.stringify({
  type: "object",
  required: ["title"],
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    status: { type: "string", enum: ["stable", "beta"] },
  },
});

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "data-schema-version-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function git(root: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args], {
    cwd: root,
    stdio: "ignore",
    env: { ...process.env, GIT_COMMITTER_DATE: "2026-03-01T10:20:30Z", GIT_AUTHOR_DATE: "2026-03-01T10:20:30Z" },
  });
}

test("a compiled schema carries its file's version and each field's type, requirement, and values", () => {
  const root = tree({ "mizzen.yml": "collections:\n  items:\n    source: _data/items.yml\n    schema: _data/items.schema.json\n", "_data/items.schema.json": SCHEMA });
  const schema = compileSchemas(root, loadConfig(root).config, {}, []).schemas["items"]!;
  assert.equal(schema.version, sha256(SCHEMA));
  assert.deepEqual(schema.fields, {
    id: { type: "string", required: false },
    title: { type: "string", required: true },
    status: { type: "string", required: false, enum: ["stable", "beta"] },
  });
});

test("data snapshot records the schema beside the commit, and the lock accepts it", async () => {
  const root = tree({
    "mizzen.yml": "collections:\n  items:\n    source: _data/items.yml\n    schema: _data/items.schema.json\n",
    "_data/items.yml": "- id: a\n  title: A\n",
    "_data/items.schema.json": SCHEMA,
  });
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "data");
  const result = await dataSnapshot({ root, name: "items" });
  assert.equal(result.code, 0, result.errors.join("\n"));
  const lock = (await readLock(root)).lock;
  assert.deepEqual(lock.snapshots?.["items"]?.schema, {
    version: sha256(SCHEMA),
    file: "_data/items.schema.json",
    fields: {
      id: { type: "string", required: false },
      title: { type: "string", required: true },
      status: { type: "string", required: false, enum: ["stable", "beta"] },
    },
  });
  assert.equal(isLock(JSON.parse(lockText(lock))), true);
});

test("data fetch records the schema of a package collection", async () => {
  const root = tree({
    "mizzen.yml": "collections:\n  pkg:\n    source: npm:@acme/data/items.yml\n    schema: _data/items.schema.json\n",
    "_data/items.schema.json": SCHEMA,
    "node_modules/@acme/data/package.json": JSON.stringify({ name: "@acme/data", version: "2.3.4" }),
    "node_modules/@acme/data/items.yml": "- id: a\n  title: A\n",
  });
  const result = await dataFetch({ root });
  assert.equal(result.code, 0, result.errors.join("\n"));
  assert.deepEqual((await readLock(root)).lock.snapshots?.["pkg"]?.schema, {
    version: sha256(SCHEMA),
    file: "_data/items.schema.json",
    fields: {
      id: { type: "string", required: false },
      title: { type: "string", required: true },
      status: { type: "string", required: false, enum: ["stable", "beta"] },
    },
  });
});

test("a recorded schema must name its version, file, and each field's requirement", () => {
  const schema = { version: "v", file: "s.json", fields: { title: { type: "string", required: true } } };
  assert.deepEqual(snapshotProblems({ source: "s", schema }), []);
  assert.notDeepEqual(snapshotProblems({ source: "s", schema: { version: "v", file: "s.json", fields: [] } }), []);
  assert.notDeepEqual(snapshotProblems({ source: "s", schema: { version: "v", file: "s.json", fields: { title: { type: "string" } } } }), []);
  assert.notDeepEqual(snapshotProblems({ source: "s", schema: { ...schema, extra: 1 } }), []);
  assert.equal(isLock({ version: 1, sources: {}, snapshots: { items: { source: "s", schema: { ...schema, extra: 1 } } } }), false);
});
