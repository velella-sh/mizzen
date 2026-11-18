import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dataSnapshot } from "../src/cli/data.ts";
import { main } from "../src/cli/index.ts";
import { loadConfig } from "../src/config/load.ts";
import { loadCollections } from "../src/data/collections.ts";

const THEME = fileURLToPath(new URL("../../lateen", import.meta.url));

const BEFORE = JSON.stringify({
  type: "object",
  required: ["id", "name"],
  properties: { id: { type: "string" }, name: { type: "string" } },
});
const AFTER = JSON.stringify({
  type: "object",
  required: ["id", "title"],
  properties: { id: { type: "number" }, title: { type: "string" } },
});
const BEFORE_RECORDS = "- id: a\n  name: Alpha\n- id: b\n  name: Beta\n";
const AFTER_RECORDS = "- id: 1\n  title: Alpha\n- id: 2\n  title: Beta\n";

function git(root: string, ...args: readonly string[]): void {
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args], { cwd: root, stdio: "ignore" });
}

/** A committed version 1 site: `name` is a string and the ids are not numeric yet. */
function site(): string {
  const root = mkdtempSync(join(tmpdir(), "data-schema-upgrade-"));
  for (const [path, text] of Object.entries({
    "mizzen.yml": "title: Upgrade\nurl: https://example.test\ncollections:\n  items:\n    source: _data/items.yml\n    schema: _data/items.schema.json\n",
    "index.md": "# Home\n",
    "_data/items.yml": BEFORE_RECORDS,
    "_data/items.schema.json": BEFORE,
  })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "version 1");
  return root;
}

/** Writes version 2 and migrates the records: `name` becomes `title`, and the ids become numbers. */
function upgradeRecords(root: string): void {
  writeFileSync(join(root, "_data", "items.schema.json"), AFTER);
  writeFileSync(join(root, "_data", "items.yml"), AFTER_RECORDS);
  git(root, "commit", "-qam", "version 2");
}

async function snapshot(root: string): Promise<void> {
  const result = await dataSnapshot({ root, name: "items" });
  assert.equal(result.code, 0, result.errors.join("\n"));
}

async function buildSite(root: string): Promise<{ readonly code: number; readonly output: string }> {
  const out = mkdtempSync(join(tmpdir(), "data-schema-upgrade-out-"));
  const lines: string[] = [];
  try {
    const code = await main(["build", root, "--out", out, "--theme", THEME], {
      log: (message: string) => void lines.push(message),
      error: (message: string) => void lines.push(message),
    });
    return { code, output: lines.join("\n") };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

test("an upgraded collection loads and builds cleanly after the records and snapshot move to version 2", async () => {
  const root = site();
  try {
    await snapshot(root);
    upgradeRecords(root);
    await snapshot(root);

    const loaded = await loadCollections({ root, config: loadConfig(root).config });
    assert.deepEqual(loaded.diagnostics.filter((diagnostic) => diagnostic.severity === "error"), []);
    assert.deepEqual(
      loaded.collections["items"]!.records.map((record) => record.fields),
      [
        { id: 1, title: "Alpha" },
        { id: 2, title: "Beta" },
      ],
    );

    const built = await buildSite(root);
    assert.equal(built.code, 0, built.output);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the same upgrade without migrated records or a new snapshot fails the build with both schema errors", async () => {
  const root = site();
  try {
    await snapshot(root);
    writeFileSync(join(root, "_data", "items.schema.json"), AFTER);
    git(root, "commit", "-qam", "schema version 2");

    const built = await buildSite(root);
    assert.equal(built.code, 1, built.output);
    assert.match(built.output, /data\.schema-type-change\s+Collection "items" field "id" field `id` changed type from `string` to `number`/);
    assert.match(built.output, /data\.schema-required-field-added\s+Collection "items" field "title" field `title` is required, and earlier records lack it/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
