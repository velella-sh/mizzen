import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config/load.ts";
import { loadCollections } from "../src/data/collections.ts";
import { sha256, storedPath, writeLock } from "../src/data/lock.ts";

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "data-read-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

test("a local source that is a directory is one diagnostic, not a rejected promise", async () => {
  const root = tree({ "mizzen.yml": "collections:\n  items:\n    source: _data/items.yml\n" });
  try {
    mkdirSync(join(root, "_data/items.yml"), { recursive: true });
    const { config } = loadConfig(root);
    const result = await loadCollections({ root, config });
    assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.id), ["data.source-unreadable"]);
    assert.match(result.diagnostics[0]!.message, /_data\/items\.yml/);
    assert.deepEqual(result.collections, {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an npm source that is a directory is one diagnostic with the package path", async () => {
  const root = tree({
    "mizzen.yml": "collections:\n  items:\n    source: npm:pkg/items.yml\n",
    "node_modules/pkg/package.json": JSON.stringify({ name: "pkg", version: "1.0.0" }),
  });
  try {
    mkdirSync(join(root, "node_modules/pkg/items.yml"), { recursive: true });
    const { config } = loadConfig(root);
    await writeLock(root, {
      version: 1,
      sources: {
        "npm:pkg/items.yml": {
          address: "npm:pkg/items.yml",
          version: "1.0.0",
          bytes: 0,
          sha256: sha256(""),
        },
      },
    });
    const result = await loadCollections({ root, config });
    assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.id), ["data.source-unreadable"]);
    assert.match(result.diagnostics[0]!.message, /node_modules\/pkg\/items\.yml/);
    assert.deepEqual(result.collections, {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stored remote bytes that are a directory are one diagnostic with the store path", async () => {
  const hash = sha256("");
  const root = tree({
    "mizzen.yml": "collections:\n  items:\n    source: https://example.test/items.csv\n",
  });
  try {
    const stored = storedPath(root, hash);
    mkdirSync(stored, { recursive: true });
    const { config } = loadConfig(root);
    await writeLock(root, {
      version: 1,
      sources: {
        "https://example.test/items.csv": {
          address: "https://example.test/items.csv",
          bytes: 0,
          sha256: hash,
        },
      },
    });
    const result = await loadCollections({ root, config });
    assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.id), ["data.store-unreadable"]);
    assert.match(result.diagnostics[0]!.message, /\.mizzen\/data\//);
    assert.deepEqual(result.collections, {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
