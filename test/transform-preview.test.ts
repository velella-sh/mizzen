import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../src/cli/index.ts";

const BIN = fileURLToPath(new URL("../bin/mizzen.ts", import.meta.url));
const FIXTURE = fileURLToPath(new URL("../fixtures/transform/", import.meta.url));

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "transform-preview-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** Every file under `dir` with its bytes, so a read-only command can prove it wrote nothing. */
function snapshot(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const rel of readdirSync(dir, { recursive: true }) as string[]) {
    const abs = join(dir, rel);
    try {
      files.set(rel, readFileSync(abs, "utf8"));
    } catch {
      files.set(rel, "<directory>");
    }
  }
  return files;
}

function run(args: readonly string[], cwd: string) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8" });
}

test("parseArgs registers data transform with a collection, a folder, --limit, and --json", () => {
  assert.deepEqual(parseArgs(["data", "transform"]), {
    options: { command: "data-transform", root: ".", json: false },
  });
  assert.deepEqual(parseArgs(["data", "transform", "items", "site", "--limit", "2", "--json"]), {
    options: { command: "data-transform", root: "site", name: "items", limit: 2, json: true },
  });
  assert.equal("error" in parseArgs(["data", "transform", "--limit", "0"]), true);
  assert.equal("error" in parseArgs(["data", "transform", "--nope"]), true);
});

test("the preview shows sample output records and writes nothing", () => {
  const before = snapshot(FIXTURE);
  const runResult = run(["data", "transform", "items", "--json", "--limit", "1"], FIXTURE);
  assert.equal(runResult.status, 0, runResult.stderr);
  const report = JSON.parse(runResult.stdout) as {
    collections: { name: string; steps: number; total: number; records: { id: string; fields: Record<string, unknown> }[] }[];
    diagnostics: unknown[];
  };
  assert.equal(report.collections.length, 1);
  assert.equal(report.collections[0]!.name, "items");
  assert.equal(report.collections[0]!.steps, 4);
  assert.equal(report.collections[0]!.total, 2);
  assert.equal(report.collections[0]!.records.length, 1, "--limit trims the sample");
  assert.deepEqual(report.collections[0]!.records[0]!.fields, { slug: "beta", label: "SECOND", price: 250 });
  assert.deepEqual(report.diagnostics, []);
  assert.deepEqual(snapshot(FIXTURE), before, "the preview read the site and wrote nothing");
});

test("the preview reports rule errors and exits 1 without writing", () => {
  const root = tree({
    "mizzen.yml": [
      "collections:",
      "  items:",
      "    source: data/items.yml",
      "    id: slug",
      "    transform:",
      "      steps:",
      "        - id: count",
      "          op: cast",
      "          field: count",
      "          to: number",
      "",
    ].join("\n"),
    "data/items.yml": "- slug: broken\n  count: many\n",
  });
  try {
    const before = snapshot(root);
    const result = run(["data", "transform"], root);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /data\.transform-cast/);
    assert.match(result.stdout, /record "broken"/);
    assert.match(result.stderr, /data\.transform-cast/);
    assert.deepEqual(snapshot(root), before, "a preview with an error still writes nothing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
