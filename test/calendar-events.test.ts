import assert from "node:assert/strict";
import { test } from "node:test";
import { fillTemplate, recordEvents } from "../src/calendar/events.ts";
import type { DataRecord } from "../src/contracts/data.ts";

const pos = { start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 1, offset: 0 } } as unknown as DataRecord["position"];

function record(fields: Record<string, unknown>, id = "node-20"): DataRecord {
  return { id, fields, position: pos, fieldPositions: {} };
}

test("two events come from two date fields, each with its title template", () => {
  const result = recordEvents(record({ title: "Node 20", eol: "2026-04-30", securityEnd: "2026-10-01" }), [
    { name: "eol", field: "eol", title: "{title} reaches end of life" },
    { name: "securityEnd", field: "securityEnd" },
  ]);
  assert.deepEqual(result, {
    events: [
      { name: "eol", start: "2026-04-30", title: "Node 20 reaches end of life" },
      { name: "securityEnd", start: "2026-10-01", title: "Node 20" },
    ],
    skipped: 0,
  });
});

test("an empty or invalid field skips its event and is counted; no date is guessed", () => {
  const result = recordEvents(record({ title: "Node 20", eol: "2026-04-30", securityEnd: null, other: "soon" }), [
    { name: "eol", field: "eol" },
    { name: "securityEnd", field: "securityEnd" },
    { name: "other", field: "other" },
    { name: "absent", field: "absent" },
  ]);
  assert.deepEqual(result.events.map((e) => e.name), ["eol"]);
  assert.equal(result.skipped, 3);
});

test("an end field makes a multi-day event; an end before the start is ignored", () => {
  const events = [{ name: "window", field: "from", end: "to" }];
  assert.equal(recordEvents(record({ title: "W", from: "2026-06-01", to: "2026-06-05" }), events).events[0]?.end, "2026-06-05");
  assert.equal(recordEvents(record({ title: "W", from: "2026-06-01", to: "2026-05-01" }), events).events[0]?.end, undefined);
  assert.equal(recordEvents(record({ title: "W", from: "2026-06-01" }), events).events[0]?.end, undefined);
});

test("normalized dates win over the written field, and a title falls back to the record id", () => {
  const rec: DataRecord = { ...record({ eol: "30 April 2026" }), normalizedDates: { eol: "2026-04-30" } };
  const result = recordEvents(rec, [{ name: "eol", field: "eol" }]);
  assert.deepEqual(result.events, [{ name: "eol", start: "2026-04-30", title: "node-20" }]);
});

test("a template reads nested fields and drops what is missing", () => {
  assert.equal(fillTemplate("{a.b} / {missing} end", { a: { b: "x" } }), "x / end");
});
