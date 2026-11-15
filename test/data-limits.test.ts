import assert from "node:assert/strict";
import { test } from "node:test";
import type { DataRecord } from "../src/contracts/index.ts";
import {
  checkFieldSizes,
  checkRecordCount,
  checkSourceBytes,
  DEFAULT_DATA_LIMITS,
  dataLimitsOf,
} from "../src/data/limits.ts";

const RECORD: DataRecord = {
  id: "a",
  fields: { name: "x".repeat(5) },
  position: { file: "items.yml", startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 },
  fieldPositions: {
    name: { file: "items.yml", startLine: 1, startColumn: 7, endLine: 1, endColumn: 11 },
  },
};

test("a collection without limits gets the documented defaults, and a key overrides only itself", () => {
  assert.deepEqual(dataLimitsOf("items", undefined), DEFAULT_DATA_LIMITS);
  assert.deepEqual(dataLimitsOf("items", { source: "_data/items.yml", limits: { bytes: 10 } }), {
    ...DEFAULT_DATA_LIMITS,
    bytes: 10,
  });
});

test("a file at its byte limit passes, one over fails naming the key, and a raised limit passes", () => {
  assert.equal(checkSourceBytes("items", "items.yml", 10, { ...DEFAULT_DATA_LIMITS, bytes: 10 }), undefined);
  const over = checkSourceBytes("items", "items.yml", 11, { ...DEFAULT_DATA_LIMITS, bytes: 10 });
  assert.equal(over?.id, "data.source-too-large");
  assert.match(over?.help ?? "", /collections\.items\.limits\.bytes/);
  assert.equal(checkSourceBytes("items", "items.yml", 11, { ...DEFAULT_DATA_LIMITS, bytes: 11 }), undefined);
});

test("record count and field size are bounded with the record and field named", () => {
  assert.equal(checkRecordCount("items", "items.yml", 2, { ...DEFAULT_DATA_LIMITS, records: 2 }), undefined);
  const many = checkRecordCount("items", "items.yml", 3, { ...DEFAULT_DATA_LIMITS, records: 2 });
  assert.equal(many?.id, "data.too-many-records");
  assert.match(many?.help ?? "", /collections\.items\.limits\.records/);

  assert.deepEqual(checkFieldSizes("items", [RECORD], { ...DEFAULT_DATA_LIMITS, field: 5 }), []);
  const long = checkFieldSizes("items", [RECORD], { ...DEFAULT_DATA_LIMITS, field: 4 });
  assert.equal(long[0]?.id, "data.field-too-large");
  assert.match(long[0]?.message ?? "", /record "a"/);
  assert.match(long[0]?.message ?? "", /Field "name"/);
  assert.equal(long[0]?.pos?.line, 1);
});
