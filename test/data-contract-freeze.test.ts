import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/** Type name to field name to type text, with `?` marking an optional field. */
type Shape = Record<string, Record<string, string>>;

const SOURCE = readFileSync(new URL("../src/contracts/data.ts", import.meta.url), "utf8");

/** Reads the field names and types of every exported interface in the data contract. */
function shape(source: string): Shape {
  const shape: Shape = {};
  for (const match of source.matchAll(/export interface (\w+) \{([\s\S]*?)\n\}/g)) {
    const fields: Record<string, string> = {};
    for (const field of match[2]!.matchAll(/^ {2}readonly (\w+)(\??): (.+);$/gm)) {
      fields[field[1]!] = `${field[2]}${field[3]}`;
    }
    shape[match[1]!] = fields;
  }
  return shape;
}

/** The same source with one field's line deleted, to prove the snapshot notices. */
function without(source: string, type: string, field: string): string {
  return source.replace(
    new RegExp(`(export interface ${type} \\{[\\s\\S]*?) {2}readonly ${field}\\??: .+;\\n`),
    "$1",
  );
}

/**
 * The frozen shape of `src/contracts/data.ts`.
 * Removing a field or changing its type fails this test. Adding a field updates this snapshot in the
 * same pull request and adds a sentence to `docs/data-sites.md`.
 */
const FROZEN: Shape = {
  RecordPos: {
    "file": "string",
    "startLine": "number",
    "startColumn": "number",
    "endLine": "number",
    "endColumn": "number",
  },
  DataRecord: {
    "id": "string",
    "fields": "Readonly<Record<string, unknown>>",
    "position": "RecordPos",
    "fieldPositions": "Readonly<Record<string, RecordPos>>",
    "keyPositions": "?Readonly<Record<string, RecordPos>>",
    "normalizedDates": "?Readonly<Record<string, string>>",
  },
  DataStats: {
    "collections": "number",
    "loaded": "number",
    "records": "number",
    "skipped": "number",
    "schemas": "number",
    "unchecked": "readonly string[]",
  },
  Collection: {
    "name": "string",
    "source": "string",
    "records": "readonly DataRecord[]",
    "package": "?{ readonly name: string; readonly version: string }",
  },
  PageRecord: {
    "collection": "string",
    "id": "string",
    "position": "RecordPos",
  },
  RecordProps: {
    "collection": "string",
    "id": "string",
    "url": "string",
    "fields": "Readonly<Record<string, unknown>>",
  },
  ListGroup: {
    "key": "string",
    "records": "readonly RecordProps[]",
  },
  ListPagination: {
    "page": "number",
    "total": "number",
    "previous": "?string",
    "next": "?string",
  },
  ListProps: {
    "collection": "string",
    "records": "readonly RecordProps[]",
    "groups": "readonly ListGroup[]",
    "pagination": "ListPagination",
  },
};

test("the data contract keeps its frozen shape", () => {
  assert.deepEqual(shape(SOURCE), FROZEN);
});

test("removing any frozen field fails the comparison", () => {
  for (const [type, fields] of Object.entries(FROZEN)) {
    for (const field of Object.keys(fields)) {
      assert.notDeepEqual(shape(without(SOURCE, type, field)), FROZEN, `${type}.${field} is guarded`);
    }
  }
});
