import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { eventId, eventLine, eventsText, parseHistory, type ChangeEvent } from "../src/data/changes/format.ts";

const date = "2026-03-01";
const changed = (record: string): ChangeEvent => ({ id: eventId("items", record, "changed", "title", date), type: "changed", record, field: "title", old: "A", new: "B", date });

test("a valid file reads back what was written, in a fixed key order", () => {
  const text = eventsText([changed("a"), { id: eventId("items", "b", "added", undefined, date), type: "added", record: "b", fields: { z: 1, a: 2 }, date }]);
  assert.match(text.split("\n")[0]!, /^\{"id":"[0-9a-f]{16}","type":"changed","record":"a","field":"title","old":"A","new":"B","date":"2026-03-01"\}$/);
  assert.match(text.split("\n")[1]!, /"fields":\{"a":2,"z":1\}/);
  const parsed = parseHistory(text);
  assert.deepEqual(parsed.problems, []);
  assert.equal(parsed.events.length, 2);
  assert.equal(eventLine(parsed.events[0]!), text.split("\n")[0]);
});

test("an invalid line is named by its number and the others still load", () => {
  const good = eventLine(changed("a"));
  const parsed = parseHistory(`${good}\n{"id":"x"}\nnot json\n${eventLine({ ...changed("a"), type: "removed" } as ChangeEvent)}\n`);
  assert.equal(parsed.events.length, 1);
  assert.match(parsed.problems[0]!, /^line 2:/);
  assert.match(parsed.problems[1]!, /^line 3: not valid JSON/);
  assert.match(parsed.problems[2]!, /^line 4:/);
});

test("the id is stable and depends on the record, type, field, and date only", () => {
  assert.equal(eventId("items", "a", "changed", "title", date), eventId("items", "a", "changed", "title", date));
  assert.notEqual(eventId("items", "a", "changed", "title", date), eventId("items", "a", "changed", "title", "2026-03-02"));
  assert.notEqual(eventId("items", "a", "changed", "title", date), eventId("items", "a", "changed", "body", date));
  assert.equal(eventId("items", "a", "changed", "title", date).length, 16);
});

test("a repeated id is a problem, and the schema file ships", () => {
  const line = eventLine(changed("a"));
  assert.match(parseHistory(`${line}\n${line}\n`).problems[0]!, /^line 2: the id/);
  assert.equal(JSON.parse(readFileSync("schema/data-changes.schema.json", "utf8")).title, "Mizzen data change event");
});
