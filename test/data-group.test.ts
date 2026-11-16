import assert from "node:assert/strict";
import { test } from "node:test";
import { groupRows, parseGroup } from "../src/data/group.ts";
import type { Row } from "../src/data/query.ts";

const rows: Row[] = [
  { id: "a", fields: { status: "stable", tags: ["ui", "docs"], date: "2026-01-05" }, dates: { date: "2026-01-05" } },
  { id: "b", fields: { status: "beta", tags: ["ui"], date: "2026-02-10" }, dates: { date: "2026-02-10" } },
  { id: "c", fields: { date: "2026-02-20" }, dates: { date: "2026-02-20" } },
];

test("a plain field groups records by value and keeps a record in each of its list groups", () => {
  const spec = parseGroup({ field: "tags" }, undefined).spec!;
  assert.deepEqual(groupRows(rows, spec).map((group) => [group.key, group.rows.map((row) => row.id)]), [
    ["(missing)", ["c"]],
    ["docs", ["a"]],
    ["ui", ["a", "b"]],
  ]);
});

test("a repeated value in a list field joins its group once", () => {
  const spec = parseGroup({ field: "tags" }, undefined).spec!;
  const repeated: Row[] = [{ id: "a", fields: { tags: ["news", "news", "ui"] } }];
  assert.deepEqual(groupRows(repeated, spec).map((group) => [group.key, group.rows.length]), [
    ["news", 1],
    ["ui", 1],
  ]);
});

test("month and year groups read the normalized date", () => {
  const month = parseGroup({ field: "date", by: "month" }, undefined).spec!;
  assert.deepEqual(groupRows(rows, month).map((group) => group.key), ["2026-01", "2026-02"]);
  const year = parseGroup({ field: "date", by: "year" }, undefined).spec!;
  assert.deepEqual(groupRows(rows, year).map((group) => [group.key, group.rows.length]), [
    ["2026", 3],
  ]);
});

test("a record without a value stays in the named missing group", () => {
  const spec = parseGroup({ field: "status", missing: "No status" }, undefined).spec!;
  assert.deepEqual(groupRows(rows, spec).map((group) => [group.key, group.rows.map((row) => row.id)]), [
    ["No status", ["c"]],
    ["beta", ["b"]],
    ["stable", ["a"]],
  ]);
});

test("groups order by size, largest first, then by key", () => {
  const spec = parseGroup({ field: "tags", order: "size" }, undefined).spec!;
  assert.deepEqual(groupRows(rows, spec).map((group) => group.key), ["ui", "(missing)", "docs"]);
});

test("a malformed group is one finding and no grouping", () => {
  const parsed = parseGroup({ field: "date", by: "week" }, undefined);
  assert.equal(parsed.spec, undefined);
  assert.deepEqual(parsed.diagnostics.map((finding) => finding.id), ["data.list-group"]);
});
