import assert from "node:assert/strict";
import { test } from "node:test";
import type { Diagnostic } from "../src/contracts/index.ts";
import { parseCsv } from "../src/data/csv.ts";

function ids(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.map((diagnostic) => diagnostic.id);
}

test("a header and rows keep values, a quoted comma, and exact spans", () => {
  const text = "id,name\r\n1,Alpha\r\n2,\"Be, ta\"\r\n";
  const result = parseCsv(text, "regions.csv");
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.header, ["id", "name"]);
  assert.deepEqual(result.rows.map((row) => row.fields), [
    { id: "1", name: "Alpha" },
    { id: "2", name: "Be, ta" },
  ]);
  assert.deepEqual(result.rows[0]!.position, {
    file: "regions.csv",
    startLine: 2,
    startColumn: 1,
    endLine: 2,
    endColumn: 7,
  });
  assert.deepEqual(result.rows[1]!.fieldPositions.name, {
    file: "regions.csv",
    startLine: 3,
    startColumn: 3,
    endLine: 3,
    endColumn: 10,
  });
});

test("doubled quotes, an embedded newline, an empty cell, and a BOM all load", () => {
  const text = "\uFEFFid,note\n1,\"a \"\"quoted\"\" line\"\n2,\n3,\"two\nlines\"\n";
  const result = parseCsv(text, "notes.csv");
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.rows.map((row) => row.fields.note), ['a "quoted" line', "", "two\nlines"]);
  assert.equal(result.header[0], "id");
  assert.deepEqual(result.rows[2]!.position, {
    file: "notes.csv",
    startLine: 4,
    startColumn: 1,
    endLine: 5,
    endColumn: 6,
  });
});

test("a duplicate header, a missing header, an unclosed quote, and a wrong row length are diagnostics", () => {
  const duplicate = parseCsv("id,id\n1,2\n", "dup.csv");
  assert.deepEqual(ids(duplicate.diagnostics), ["data.csv-duplicate-header"]);
  assert.equal(duplicate.diagnostics[0]!.pos?.line, 1);
  assert.equal(duplicate.diagnostics[0]!.pos?.column, 4);
  assert.deepEqual(duplicate.rows.map((row) => row.fields), [{ id: "1" }]);

  const missing = parseCsv("", "empty.csv");
  assert.deepEqual(ids(missing.diagnostics), ["data.csv-missing-header"]);

  const unclosed = parseCsv("id,note\n1,\"open\n", "open.csv");
  assert.deepEqual(ids(unclosed.diagnostics), ["data.csv-unclosed-quote"]);
  assert.equal(unclosed.diagnostics[0]!.pos?.line, 2);
  assert.equal(unclosed.diagnostics[0]!.pos?.column, 3);
  assert.deepEqual(unclosed.rows, []);

  const short = parseCsv("id,note\n1\n2,two\n", "short.csv");
  assert.deepEqual(ids(short.diagnostics), ["data.csv-row-length"]);
  assert.deepEqual(short.rows.map((row) => row.fields), [{ id: "2", note: "two" }]);
});
