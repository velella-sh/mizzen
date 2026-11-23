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
    "source": "?string",
    "editable": "?boolean",
  },
  DataRecord: {
    "id": "string",
    "fields": "Readonly<Record<string, unknown>>",
    "position": "RecordPos",
    "fieldPositions": "Readonly<Record<string, RecordPos>>",
    "keyPositions": "?Readonly<Record<string, RecordPos>>",
    "normalizedDates": "?Readonly<Record<string, string>>",
    "inputs": "?readonly string[]",
    "derived": "?Readonly<Record<string, unknown>>",
    "joined": "?JoinedOutput",
    "knowledge": "?import(\"./knowledge.ts\").KnowledgeDeclaration",
  },
  JoinedField: {
    "field": "string",
    "source": "string",
    "input": "string",
    "inputs": "readonly string[]",
    "reason": "\"only\" | \"precedence\" | \"null-fallthrough\"",
  },
  JoinedOutput: {
    "key": "Readonly<Record<string, string>>",
    "fields": "Readonly<Record<string, JoinedField>>",
  },
  ChangeEvent: {
    "id": "string",
    "type": "ChangelogEventType",
    "record": "string",
    "field": "?string",
    "old": "?unknown",
    "new": "?unknown",
    "from": "?string",
    "fields": "?Readonly<Record<string, unknown>>",
    "count": "?number",
    "ref": "?string",
    "date": "string",
  },
  DataStats: {
    "collections": "number",
    "loaded": "number",
    "read": "number",
    "kept": "number",
    "skipped": "number",
    "schemas": "number",
    "unchecked": "readonly string[]",
  },
  SchemaFieldSnapshot: {
    "type": "?string",
    "required": "boolean",
    "enum": "?readonly unknown[]",
  },
  SchemaSnapshot: {
    "version": "string",
    "file": "string",
    "fields": "Readonly<Record<string, SchemaFieldSnapshot>>",
  },
  Collection: {
    "name": "string",
    "source": "string",
    "records": "readonly DataRecord[]",
    "package": "?{ readonly name: string; readonly version: string }",
    "snapshot": "?CollectionSnapshot",
    "readonly": "?boolean",
  },
  CollectionSnapshot: {
    "source": "string",
    "ref": "?string",
    "capturedAt": "?string",
    "tool": "?string",
    "toolVersion": "?string",
    "schema": "?SchemaSnapshot",
  },
  PageRecord: {
    "collection": "string",
    "id": "string",
    "position": "RecordPos",
    "template": "string",
    "templateLine": "number",
    "fallbacks": "readonly string[]",
    "view": "?string",
    "views": "?Readonly<Record<string, string>>",
    "previousUrls": "?readonly string[]",
    "replacementUrl": "?string",
    "changes": "?readonly ChangeEvent[]",
  },
  RecordProps: {
    "collection": "string",
    "id": "string",
    "url": "string",
    "fields": "Readonly<Record<string, unknown>>",
    "links": "Readonly<Record<string, string>>",
    "related": "?RecordRelations",
    "derived": "?Readonly<Record<string, unknown>>",
    "views": "?Readonly<Record<string, string>>",
    "calendar": "?string",
    "calendars": "?readonly CalendarLink[]",
    "changes": "?readonly ChangeEvent[]",
  },
  RelatedRecord: {
    "collection": "string",
    "id": "string",
    "url": "string",
    "fields": "Readonly<Record<string, unknown>>",
  },
  CalendarLink: {
    "name": "string",
    "title": "string",
    "url": "string",
    "webcal": "string",
  },
  ListGroup: {
    "key": "string",
    "records": "readonly RecordProps[]",
    "url": "?string",
    "count": "?number",
    "calendars": "?readonly CalendarLink[]",
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
    "calendars": "?readonly CalendarLink[]",
    "feed": "?string",
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
