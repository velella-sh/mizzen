import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJson } from "../src/data/lock.ts";
import { parseTrace } from "../src/trace/parse.ts";
import { boundTrace } from "../src/trace/retain.ts";
import { traceFixture, longTraceFixture } from "./trace-fixture.ts";

test("a trace inside the limits comes back unchanged", () => {
  const trace = traceFixture();
  const bound = boundTrace(trace, { maxEvents: 500, maxBytes: 100_000 });
  assert.equal(bound.trace, trace);
  assert.equal(bound.truncation, undefined);
});

test("the event cap keeps the root, decision, receipt target, and final state, and drops the rest", () => {
  const trace = longTraceFixture(20);
  const bound = boundTrace(trace, { maxEvents: 6, maxBytes: 100_000 });
  const kept = bound.trace.events;
  assert.ok(kept.length <= 6);
  assert.equal(kept.length, 6);
  assert.deepEqual(
    kept.map((event) => event.capability),
    ["call.0", "call.1", "call.2", "call.3", "call.10", "call.19"],
  );
  assert.deepEqual(parseTrace(bound.trace).problems, []);
  assert.equal(bound.truncation?.droppedEvents, 14);
  assert.ok((bound.truncation?.droppedBytes ?? 0) > 0);
  assert.match(bound.truncation?.summary ?? "", /Kept 6 of 20 events \(14 dropped/);
  assert.equal(bound.trace.events[4]?.kind, "decision");
  assert.deepEqual(bound.trace.events.map((event) => event.sequence), [0, 1, 2, 3, 4, 5]);
  for (const event of bound.trace.events) {
    if (event.sequence > 0) assert.ok(event.parent !== null && event.parent < event.sequence);
  }
  assert.equal(bound.trace.receipts.length, 1);
});

test("the byte cap drops ordinary events but keeps every proof-critical event", () => {
  const trace = longTraceFixture(40);
  const full = Buffer.byteLength(canonicalJson(trace.events), "utf8");
  const bound = boundTrace(trace, { maxEvents: 500, maxBytes: Math.floor(full / 2) });
  assert.ok(bound.trace.events.length < trace.events.length);
  assert.ok((bound.truncation?.droppedEvents ?? 0) > 0);
  const capabilities = bound.trace.events.map((event) => event.capability);
  assert.ok(capabilities.includes("call.0"));
  assert.ok(capabilities.includes("call.20"));
  assert.ok(capabilities.includes("call.39"));
  assert.ok(capabilities.includes("call.2"));
  assert.deepEqual(parseTrace(bound.trace).problems, []);
});

test("when every event is proof-critical the trace is kept, with no false truncation record", () => {
  const trace = traceFixture();
  const bound = boundTrace(trace, { maxEvents: 2, maxBytes: 1 });
  assert.equal(bound.truncation, undefined);
  assert.equal(bound.trace.id, trace.id);
  assert.equal(bound.trace.events.length, trace.events.length);
});
