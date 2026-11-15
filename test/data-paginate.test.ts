import assert from "node:assert/strict";
import { test } from "node:test";
import { paginateRows } from "../src/data/paginate.ts";
import type { Grouping } from "../src/data/group.ts";

const rows = Array.from({ length: 7 }, (_value, index) => ({ id: String(index + 1) }));
const groups: Grouping<{ id: string }>[] = [
  { key: "a", rows: rows.slice(0, 3) },
  { key: "b", rows: rows.slice(3, 5) },
  { key: "c", rows: rows.slice(5) },
];

test("an exact multiple gives no empty last page", () => {
  assert.deepEqual(paginateRows(rows.slice(0, 6), [], 3, false).map((slice) => slice.rows.length), [3, 3]);
});

test("one item over fills a last page with one row", () => {
  assert.deepEqual(paginateRows(rows, [], 3, false).map((slice) => slice.rows.length), [3, 3, 1]);
});

test("a list that fits is one page whatever the page size", () => {
  assert.deepEqual(paginateRows(rows.slice(0, 2), [], 10, false).map((slice) => slice.rows.length), [2]);
});

test("a page with no perPage is one page", () => {
  assert.deepEqual(paginateRows(rows, groups, undefined, false).map((slice) => slice.rows.length), [7]);
});

test("grouped pages keep a group whole unless the page asks to split it", () => {
  assert.deepEqual(
    paginateRows(rows, groups, 4, false).map((slice) => slice.groups.map((group) => group.key)),
    [["a"], ["b", "c"]],
  );
  assert.deepEqual(
    paginateRows(rows, groups, 4, true).map((slice) => slice.rows.length),
    [4, 3],
  );
});
