import assert from "node:assert/strict";
import { test } from "node:test";
import { dayOf, eventUid, sequenceOf, stampOf } from "../src/calendar/uid.ts";
import { writeIcs } from "../src/calendar/ics.ts";

const parts = { origin: "https://docs.example.com/base/", collection: "runtimes", record: "node-20", event: "eol" };

test("the id is the collection, record, event, and host, and encodes separators", () => {
  assert.equal(eventUid(parts), "runtimes/node-20/eol@docs.example.com");
  assert.equal(eventUid({ ...parts, record: "a/b@c" }), "runtimes/a%2Fb%40c/eol@docs.example.com");
});

test("a renamed record page keeps its id: the page URL is not an input", () => {
  const before = eventUid(parts);
  const after = eventUid({ ...parts, origin: "https://docs.example.com/other/path/" });
  assert.equal(before, after);
  assert.notEqual(eventUid({ ...parts, record: "node-22" }), before);
  assert.notEqual(eventUid({ ...parts, event: "support" }), before);
});

test("the stamp is the record's updated field, then the snapshot date, then the as-of date", () => {
  assert.equal(stampOf({ updated: "2026-03-04", snapshot: "2026-02-01", asOf: "2026-01-01" }), "2026-03-04");
  assert.equal(stampOf({ updated: "2026-03-04T23:30:00Z" }), "2026-03-04");
  assert.equal(stampOf({ snapshot: "2026-02-01T10:00:00Z", asOf: "2026-01-01" }), "2026-02-01");
  assert.equal(stampOf({ updated: "soon", asOf: "2026-01-01" }), "2026-01-01");
  assert.equal(stampOf({ updated: 5 }), undefined);
  assert.equal(dayOf(""), undefined);
});

test("two builds with different clocks write the same bytes", () => {
  const build = () =>
    writeIcs({
      events: [{ uid: eventUid(parts), stamp: stampOf({ updated: "2026-03-04" })!, start: "2026-04-30", summary: "x" }],
    });
  const RealDate = Date;
  const first = build();
  // A later clock: if anything read it, the bytes would differ.
  globalThis.Date = class extends RealDate {
    constructor(...args: ConstructorParameters<typeof RealDate>) {
      super(...(args.length === 0 ? [RealDate.UTC(2031, 5, 5)] : args) as [number]);
    }
    static override now() {
      return RealDate.UTC(2031, 5, 5);
    }
  } as DateConstructor;
  try {
    assert.equal(build(), first);
  } finally {
    globalThis.Date = RealDate;
  }
});

test("the sequence rises only when the date or the title changes", () => {
  const recorded = { start: "2026-04-30", title: "Node 20 ends", sequence: 1 };
  assert.equal(sequenceOf(undefined, { start: "2026-04-30", title: "Node 20 ends" }), 0);
  assert.equal(sequenceOf(recorded, { start: "2026-04-30", title: "Node 20 ends" }), 1);
  assert.equal(sequenceOf(recorded, { start: "2026-05-30", title: "Node 20 ends" }), 2);
  assert.equal(sequenceOf(recorded, { start: "2026-04-30", title: "Node 20 end of life" }), 2);
  assert.equal(sequenceOf(recorded, { start: "2026-04-30", end: "2026-04-30", title: "Node 20 ends" }), 1);
  assert.equal(sequenceOf(recorded, { start: "2026-04-30", end: "2026-05-02", title: "Node 20 ends" }), 2);
});
