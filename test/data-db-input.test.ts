import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { dataExtract } from "../src/cli/data.ts";
import { loadConfig, loadConfigText } from "../src/config/load.ts";
import { loadCollections } from "../src/data/collections.ts";
import { readLock, storedPath } from "../src/data/lock.ts";

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "data-db-input-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function database(root: string, path: string, sql: string): string {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(sql);
  db.close();
  return file;
}

function hashOf(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function resultText(root: string, name = "products"): string {
  const lock = JSON.parse(readFileSync(join(root, "mizzen.lock.json"), "utf8")) as {
    extractions: Record<string, { sha256: string }>;
  };
  return readFileSync(storedPath(root, lock.extractions[name]!.sha256), "utf8");
}

const PRODUCTS_SQL = `
  CREATE TABLE products (sku TEXT PRIMARY KEY, name TEXT NOT NULL, price REAL NOT NULL, released TEXT);
  INSERT INTO products (sku, name, price, released) VALUES
    ('widget', 'Widget', 12.5, '2026-01-15'),
    ('gadget', 'Gadget', 7, NULL);
`;

test("invalid SQLite and NDJSON configuration is refused before a file is opened (#918)", () => {
  const missing = loadConfigText(
    "collections:\n  products:\n    source: _data/products.sqlite\n",
    "mizzen.yml",
    "site",
  );
  assert.ok(missing.diagnostics.some((diagnostic) => diagnostic.severity === "error"));

  const write = loadConfigText(
    "collections:\n  products:\n    source: _data/products.sqlite\n    sqlite:\n      query: DELETE FROM products\n",
    "mizzen.yml",
    "site",
  );
  assert.equal(write.diagnostics.some((diagnostic) => diagnostic.id === "config.sqlite-query"), true);

  const records = loadConfigText(
    "collections:\n  products:\n    source: _data/products.sqlite\n    records: data.items\n    sqlite:\n      query: SELECT 1\n",
    "mizzen.yml",
    "site",
  );
  assert.ok(records.diagnostics.some((diagnostic) => diagnostic.severity === "error"));

  const sqliteOnNdjson = loadConfigText(
    "collections:\n  products:\n    source: _data/products.ndjson\n    sqlite:\n      query: SELECT 1\n",
    "mizzen.yml",
    "site",
  );
  assert.ok(sqliteOnNdjson.diagnostics.some((diagnostic) => diagnostic.severity === "error"));
});

test("SQLite extraction is read-only, parameterized, mapped, sorted, and byte-identical when repeated (#919-#923, #927)", async () => {
  const root = tree({
    "mizzen.yml": [
      "collections:",
      "  products:",
      "    source: _data/products.sqlite",
      "    id: sku",
      "    sqlite:",
      "      query: SELECT sku, name, price, released FROM products WHERE price >= ?",
      "      params: [1]",
      "      id: catalog-products",
      "      order: [name]",
      "",
    ].join("\n"),
  });
  try {
    const db = database(root, "_data/products.sqlite", PRODUCTS_SQL);
    const before = hashOf(db);

    const first = await dataExtract({ root });
    assert.deepEqual(first.errors, []);
    assert.equal(first.code, 0);
    assert.equal(hashOf(db), before, "the fixture database is unchanged");

    const lock = await readLock(root);
    const entry = lock.lock.extractions?.products;
    assert.ok(entry);
    assert.equal(entry.source, "_data/products.sqlite");
    assert.equal(entry.query, "catalog-products");
    assert.match(entry.querySha256, /^[0-9a-f]{64}$/);
    assert.equal(entry.records, 2);
    assert.equal(readFileSync(storedPath(root, entry.sha256), "utf8").split("\n").filter(Boolean).length, 2);

    const lockText = readFileSync(join(root, "mizzen.lock.json"), "utf8");
    const second = await dataExtract({ root });
    assert.equal(second.code, 0);
    assert.ok(second.messages.some((message) => message.startsWith("unchanged")));
    assert.equal(readFileSync(join(root, "mizzen.lock.json"), "utf8"), lockText, "repeated extraction is byte-identical");

    const records = await loadCollections({ root, config: loadConfig(root).config });
    assert.deepEqual(records.diagnostics, []);
    assert.deepEqual(records.collections.products?.records.map((record) => record.id), ["gadget", "widget"], "rows sort by key");

    // The same query with a fixed parameter selects one row, and a write is refused before it runs.
    writeFileSync(join(root, "mizzen.yml"), [
      "collections:",
      "  products:",
      "    source: _data/products.sqlite",
      "    id: sku",
      "    sqlite:",
      "      query: SELECT sku, name FROM products WHERE price > ?",
      "      params: [10]",
      "",
    ].join("\n"));
    const filtered = await dataExtract({ root });
    assert.deepEqual(filtered.errors, []);
    assert.equal(resultText(root).trim(), '{"name":"Widget","sku":"widget"}');

    writeFileSync(join(root, "mizzen.yml"), [
      "collections:",
      "  products:",
      "    source: _data/products.sqlite",
      "    sqlite:",
      "      query: UPDATE products SET price = 0",
      "",
    ].join("\n"));
    const rejected = await dataExtract({ root });
    assert.equal(rejected.code, 1);
    assert.ok(rejected.errors.some((message) => /read statement|SELECT/i.test(message)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a consistent SQLite snapshot never mixes an uncommitted write into one extraction (#923)", async () => {
  const root = tree({
    "mizzen.yml": "collections:\n  products:\n    source: _data/products.sqlite\n    id: sku\n    sqlite:\n      query: SELECT sku, name, price FROM products\n",
  });
  try {
    const db = database(root, "_data/products.sqlite", PRODUCTS_SQL);
    const writer = new DatabaseSync(db);
    try {
      writer.exec("PRAGMA journal_mode = WAL");
      writer.exec("BEGIN IMMEDIATE");
      writer.exec("UPDATE products SET price = 99 WHERE sku = 'widget'");

      const during = await dataExtract({ root });
      assert.deepEqual(during.errors, []);
      assert.match(resultText(root), /"price":12\.5/, "the uncommitted price is not visible");
      assert.match(resultText(root), /"price":7/);

      writer.exec("COMMIT");
      const after = await dataExtract({ root });
      assert.deepEqual(after.errors, []);
      assert.match(resultText(root), /"price":99/);
    } finally {
      writer.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("null, number, text, and binary values follow the contract, and binary: error names the column (#921)", async () => {
  const root = tree({
    "mizzen.yml": "collections:\n  products:\n    source: _data/values.sqlite\n    sqlite:\n      query: SELECT id, note, amount, title, payload FROM sample\n",
  });
  try {
    database(root, "_data/values.sqlite", `
      CREATE TABLE sample (id TEXT, note TEXT, amount REAL, title TEXT, payload BLOB);
      INSERT INTO sample VALUES ('a', NULL, 1.5, 'text', x'00ff');
    `);
    const extracted = await dataExtract({ root });
    assert.deepEqual(extracted.errors, []);
    assert.equal(resultText(root).trim(), '{"amount":1.5,"id":"a","note":null,"payload":"AP8=","title":"text"}');

    writeFileSync(join(root, "mizzen.yml"), [
      "collections:",
      "  products:",
      "    source: _data/values.sqlite",
      "    sqlite:",
      "      query: SELECT id, payload FROM sample",
      "      binary: error",
      "",
    ].join("\n"));
    const rejected = await dataExtract({ root });
    assert.equal(rejected.code, 1);
    assert.ok(rejected.errors.some((message) => message.includes("payload")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("NDJSON streams line by line and reports line-numbered errors and limits without a partial result (#924-#926)", async () => {
  const lines = Array.from({ length: 20_000 }, (_, index) => JSON.stringify({ id: `item-${index}` })).join("\n");
  const root = tree({
    "mizzen.yml": "collections:\n  products:\n    source: _data/products.ndjson\n    limits:\n      records: 5\n",
    "_data/products.ndjson": `${lines}\n`,
  });
  try {
    const limited = await dataExtract({ root });
    assert.equal(limited.code, 1);
    assert.ok(limited.errors.some((message) => /limit is 5/.test(message)));
    assert.equal(existsSync(join(root, "mizzen.lock.json")), false, "no partial lock");
    assert.equal(existsSync(join(root, ".mizzen")), false, "no partial store");

    writeFileSync(join(root, "mizzen.yml"), "collections:\n  products:\n    source: _data/products.ndjson\n");
    writeFileSync(join(root, "_data/products.ndjson"), '{"id":"a"}\nnot json\n');
    const invalid = await dataExtract({ root });
    assert.equal(invalid.code, 1);
    assert.ok(invalid.errors.some((message) => message.includes("Line 2")));

    writeFileSync(join(root, "_data/products.ndjson"), '["not a record"]\n');
    const notRecord = await dataExtract({ root });
    assert.equal(notRecord.code, 1);
    assert.ok(notRecord.errors.some((message) => message.includes("Line 1")));

    writeFileSync(join(root, "_data/products.ndjson"), `${"x".repeat(64)}\n`);
    writeFileSync(join(root, "mizzen.yml"), "collections:\n  products:\n    source: _data/products.ndjson\n    limits:\n      bytes: 8\n");
    const tooLarge = await dataExtract({ root });
    assert.equal(tooLarge.code, 1);
    assert.ok(tooLarge.errors.some((message) => /limit is 8/.test(message)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("one failed collection leaves every extraction inactive (#926)", async () => {
  const root = tree({
    "mizzen.yml": [
      "collections:",
      "  products:",
      "    source: _data/products.ndjson",
      "  broken:",
      "    source: _data/broken.ndjson",
      "",
    ].join("\n"),
    "_data/products.ndjson": '{"id":"a"}\n',
    "_data/broken.ndjson": '{"id":"b"}\noops\n',
  });
  try {
    const result = await dataExtract({ root });
    assert.equal(result.code, 1);
    assert.equal(existsSync(join(root, "mizzen.lock.json")), false);
    assert.equal(existsSync(join(root, ".mizzen")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a build reads only the locked result and reports missing, stale, and changed results (#927)", async () => {
  const config = [
    "collections:",
    "  products:",
    "    source: _data/products.ndjson",
    "",
  ].join("\n");
  const root = tree({ "mizzen.yml": config, "_data/products.ndjson": '{"id":"b","name":"Beta"}\n{"id":"a","name":"Alpha"}\n' });
  try {
    const before = await dataExtract({ root });
    assert.deepEqual(before.errors, []);
    unlinkSync(join(root, "_data/products.ndjson"));
    const loaded = await loadCollections({ root, config: loadConfig(root).config });
    assert.deepEqual(loaded.diagnostics, []);
    assert.deepEqual(loaded.collections.products?.records.map((record) => record.id), ["a", "b"]);

    const lock = await readLock(root);
    const entry = lock.lock.extractions!.products!;
    writeFileSync(storedPath(root, entry.sha256), "tampered\n");
    const tampered = await loadCollections({ root, config: loadConfig(root).config });
    assert.equal(tampered.diagnostics[0]?.id, "data.store-mismatch");

    rmSync(join(root, ".mizzen"), { recursive: true, force: true });
    const missing = await loadCollections({ root, config: loadConfig(root).config });
    assert.equal(missing.diagnostics[0]?.id, "data.store-missing");

    const empty = tree({ "mizzen.yml": config, "_data/products.ndjson": '{"id":"a"}\n' });
    try {
      const absent = await loadCollections({ root: empty, config: loadConfig(empty).config });
      assert.equal(absent.diagnostics[0]?.id, "data.extraction-missing");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }

    writeFileSync(join(root, "mizzen.yml"), `${config}    id: sku\n`);
    const stale = await loadCollections({ root, config: loadConfig(root).config });
    assert.equal(stale.diagnostics[0]?.id, "data.extraction-stale");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a schema error identifies the extracted row and record key (#928)", async () => {
  const root = tree({
    "mizzen.yml": [
      "collections:",
      "  products:",
      "    source: _data/products.sqlite",
      "    id: sku",
      "    schema: schema.json",
      "    sqlite:",
      "      query: SELECT sku, price FROM products",
      "",
    ].join("\n"),
    "schema.json": JSON.stringify({
      type: "object",
      required: ["sku", "price"],
      properties: { sku: { type: "string" }, price: { type: "string" } },
    }),
  });
  try {
    database(root, "_data/products.sqlite", `
      CREATE TABLE products (sku TEXT, price REAL);
      INSERT INTO products VALUES ('b', 1.5), ('a', 2.5);
    `);
    assert.deepEqual((await dataExtract({ root })).errors, []);
    const loaded = await loadCollections({ root, config: loadConfig(root).config });
    const finding = loaded.diagnostics.find((diagnostic) => diagnostic.id === "data.record-invalid");
    assert.ok(finding);
    assert.match(finding.message, /record "a"/);
    assert.equal(finding.pos?.line, 1, "the sorted first row is line 1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("equivalent SQLite and NDJSON inputs produce the same catalog and result bytes (#929)", async () => {
  const ndjson = '{"sku":"widget","name":"Widget","price":12.5,"released":"2026-01-15"}\n{"sku":"gadget","name":"Gadget","price":7,"released":null}\n';
  const sqliteRoot = tree({
    "mizzen.yml": "collections:\n  products:\n    source: _data/products.sqlite\n    id: sku\n    sqlite:\n      query: SELECT sku, name, price, released FROM products\n",
  });
  const ndjsonRoot = tree({
    "mizzen.yml": "collections:\n  products:\n    source: _data/products.ndjson\n    id: sku\n",
    "_data/products.ndjson": ndjson,
  });
  try {
    database(sqliteRoot, "_data/products.sqlite", PRODUCTS_SQL);
    assert.deepEqual((await dataExtract({ root: sqliteRoot })).errors, []);
    assert.deepEqual((await dataExtract({ root: ndjsonRoot })).errors, []);

    const sqliteLock = (await readLock(sqliteRoot)).lock.extractions!.products!;
    const ndjsonLock = (await readLock(ndjsonRoot)).lock.extractions!.products!;
    assert.equal(sqliteLock.sha256, ndjsonLock.sha256, "the canonical results are the same bytes");
    assert.equal(readFileSync(storedPath(sqliteRoot, sqliteLock.sha256), "utf8"), readFileSync(storedPath(ndjsonRoot, ndjsonLock.sha256), "utf8"));

    const sqlite = await loadCollections({ root: sqliteRoot, config: loadConfig(sqliteRoot).config });
    const nd = await loadCollections({ root: ndjsonRoot, config: loadConfig(ndjsonRoot).config });
    assert.deepEqual(sqlite.diagnostics, []);
    assert.deepEqual(nd.diagnostics, []);
    assert.deepEqual(
      sqlite.collections.products?.records.map((record) => [record.id, record.fields]),
      nd.collections.products?.records.map((record) => [record.id, record.fields]),
    );
  } finally {
    rmSync(sqliteRoot, { recursive: true, force: true });
    rmSync(ndjsonRoot, { recursive: true, force: true });
  }
});
