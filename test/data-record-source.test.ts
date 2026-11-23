/**
 * A record's position names the source the config gave and says whether `file` is a real local file the author can
 * edit: true for a file in the site, false for a pinned download, a locked extraction, and so on.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { dataExtract } from "../src/cli/data.ts";
import { loadConfig } from "../src/config/load.ts";
import { loadCollections } from "../src/data/collections.ts";
import { sha256, storedPath, writeLock } from "../src/data/lock.ts";

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "data-record-source-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

async function firstPosition(root: string, name: string) {
  const loaded = await loadCollections({ root, config: loadConfig(root).config });
  assert.deepEqual(loaded.diagnostics.filter((d) => d.severity === "error"), []);
  const record = loaded.collections[name]!.records[0]!;
  return { position: record.position, field: Object.values(record.fieldPositions)[0]!, key: Object.values(record.keyPositions ?? {})[0] };
}

test("a record of a local file names it and is editable", async () => {
  const root = tree({ "mizzen.yml": "collections:\n  items:\n    source: _data/items.yml\n", "_data/items.yml": "- id: a\n  name: A\n" });
  try {
    const { position, field } = await firstPosition(root, "items");
    assert.equal(position.file, "_data/items.yml");
    for (const pos of [position, field]) {
      assert.equal(pos.source, "_data/items.yml");
      assert.equal(pos.editable, true);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a record of a pinned https source names the URL and is not editable", async () => {
  const url = "https://example.test/items.json";
  const bytes = '[{"id":"a","name":"A"}]\n';
  const hash = sha256(bytes);
  const root = tree({ "mizzen.yml": `collections:\n  items:\n    source: ${url}\n` });
  try {
    mkdirSync(dirname(storedPath(root, hash)), { recursive: true });
    writeFileSync(storedPath(root, hash), bytes);
    await writeLock(root, { version: 1, sources: { [url]: { address: url, bytes: bytes.length, sha256: hash } } });
    const { position, field } = await firstPosition(root, "items");
    assert.equal(position.file, `.mizzen/data/${hash}`);
    for (const pos of [position, field]) {
      assert.equal(pos.source, url);
      assert.equal(pos.editable, false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("records of an NDJSON or SQLite extraction name the source, are not editable, and count lines of the stored result", async () => {
  const root = tree({
    "mizzen.yml": [
      "collections:",
      "  rows:",
      "    source: _data/rows.ndjson",
      "  products:",
      "    source: _data/products.sqlite",
      "    id: sku",
      "    sqlite:",
      "      query: SELECT sku, name FROM products",
      "      id: all",
      "      order: [sku]",
      "",
    ].join("\n"),
    "_data/rows.ndjson": '{"id":"b"}\n\n{"id":"a"}\n',
  });
  try {
    const db = new DatabaseSync(join(root, "_data/products.sqlite"));
    db.exec("CREATE TABLE products (sku TEXT PRIMARY KEY, name TEXT); INSERT INTO products VALUES ('x', 'X');");
    db.close();
    assert.equal((await dataExtract({ root })).code, 0);
    for (const [name, source] of [["rows", "_data/rows.ndjson"], ["products", "_data/products.sqlite"]] as const) {
      const { position } = await firstPosition(root, name);
      assert.match(position.file, /^\.mizzen\/data\/[0-9a-f]{64}$/);
      assert.equal(position.source, source);
      assert.equal(position.editable, false);
      assert.equal(position.startLine, 1, "the line is the record's row in the stored result");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
