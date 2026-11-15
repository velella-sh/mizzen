import assert from "node:assert/strict";
import { test } from "node:test";
import { filterRows, parseQuery, sortRows, type Row } from "../src/data/query.ts";

const rows: Row[] = [
  { id: "c", fields: { status: "stable", rank: 2, tags: ["a", "b"], date: "2026-03-10" } },
  { id: "a", fields: { status: "beta", rank: 2, tags: ["b"], date: "2026-01-05" } },
  { id: "b", fields: { status: "stable", rank: 10 } },
];

/** Reads a `where` and `sort` with a fixed reference date; the diagnostics are returned with the selected ids. */
function select(where: unknown, sort: unknown, reference = "2026-03-15"): string[] {
  const query = parseQuery(where, sort, { file: "blog.md", collection: "posts", reference });
  assert.deepEqual(query.diagnostics, []);
  return sortRows(filterRows(rows, query.where), query.sort).map((row) => row.id);
}

test("equals compares scalars as text and a list is one of", () => {
  assert.deepEqual(select({ status: "stable" }, undefined), ["c", "b"]);
  assert.deepEqual(select({ status: "stable", rank: 10 }, undefined), ["b"]);
});

test("a list value matches when any item is in the list", () => {
  assert.deepEqual(select({ tags: ["a"] }, undefined), ["c"]);
  assert.deepEqual(select({ tags: ["b"] }, ["rank desc"]), ["a", "c"]);
});

test("exists keeps records that hold a value, and exists: false those that do not", () => {
  assert.deepEqual(select({ tags: { exists: true } }, undefined), ["c", "a"]);
  assert.deepEqual(select({ tags: { exists: false } }, undefined), ["b"]);
});

test("before and after compare a date field with a fixed date", () => {
  assert.deepEqual(select({ date: { before: "2026-02-01" } }, undefined), ["a"]);
  assert.deepEqual(select({ date: { after: "2026-02-01" } }, undefined), ["c"]);
});

test("a relative date moves the collection's reference date by days or months", () => {
  assert.deepEqual(select({ date: { after: "reference-90d" } }, undefined), ["c", "a"]);
  assert.deepEqual(select({ date: { before: "reference-2m" } }, undefined), ["a"]);
});

test("a relative date without a reference date is one error at the list", () => {
  const query = parseQuery({ date: { after: "reference" } }, undefined, { file: "blog.md", collection: "posts" });
  assert.deepEqual(query.where, []);
  assert.deepEqual(query.diagnostics.map((finding) => finding.id), ["data.reference-date"]);
});

test("sort reads two keys and falls back to the id, then to source order", () => {
  assert.deepEqual(select(undefined, ["rank desc", "status"]), ["b", "a", "c"]);
  assert.deepEqual(select(undefined, "status desc"), ["b", "c", "a"]);
});

test("a record without the sort field sorts last", () => {
  assert.deepEqual(select(undefined, "date"), ["a", "c", "b"]);
});

test("a record without the sort field sorts last, ascending and descending", () => {
  const ranked: Row[] = [
    { id: "a", fields: { rank: 2 } },
    { id: "b", fields: { rank: 1 } },
    { id: "c", fields: {} },
  ];
  const read = (sort: string) => {
    const query = parseQuery(undefined, sort, { file: "blog.md", collection: "posts" });
    assert.deepEqual(query.diagnostics, []);
    return sortRows(ranked, query.sort).map((row) => row.id);
  };
  assert.deepEqual(read("rank"), ["b", "a", "c"]);
  assert.deepEqual(read("rank desc"), ["a", "b", "c"]);
});

test("a sort direction that is not asc or desc is an error, not a field name", () => {
  const query = parseQuery(undefined, "title descending", { file: "blog.md", collection: "posts" });
  assert.deepEqual(query.diagnostics.map((finding) => finding.id), ["data.list-sort"]);
  assert.deepEqual(query.sort, []);
});

test("a malformed where or sort is one finding and leaves the records alone", () => {
  const where = parseQuery({ status: { near: "stable" } }, undefined, { file: "blog.md", collection: "posts" });
  assert.deepEqual(where.diagnostics.map((finding) => finding.id), ["data.list-where"]);
  assert.deepEqual(where.where, []);
  const sort = parseQuery(undefined, ["a", "b", "c"], { file: "blog.md", collection: "posts" });
  assert.deepEqual(sort.diagnostics.map((finding) => finding.id), ["data.list-sort"]);
  assert.deepEqual(sort.sort, []);
  for (const bad of [[], "status", { status: [{ nested: true }] }, { status: {} }, { status: { before: 5 } }]) {
    const parsed = parseQuery(bad, undefined, { file: "blog.md", collection: "posts" });
    assert.deepEqual(parsed.diagnostics.map((finding) => finding.id), ["data.list-where"]);
    assert.deepEqual(parsed.where, []);
  }
});
