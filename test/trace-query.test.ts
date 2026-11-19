import assert from "node:assert/strict";
import { test } from "node:test";
import { boundTrace } from "../src/trace/retain.ts";
import { compactSummary, matchesEvent, searchTrace, summaryOf } from "../src/trace/query.ts";
import { longTraceFixture, FIXTURE_TASK, traceFixture } from "./trace-fixture.ts";

test("search filters by stage, file, task, and status, and combinations narrow", () => {
  const trace = traceFixture();
  assert.deepEqual(searchTrace(trace, { stage: "edit" }).map((event) => event.sequence), [2]);
  assert.deepEqual(searchTrace(trace, { file: "docs/install.md" }).map((event) => event.sequence), [2, 3]);
  assert.deepEqual(searchTrace(trace, { status: "failed" }).map((event) => event.sequence), [3]);
  assert.deepEqual(searchTrace(trace, { task: FIXTURE_TASK.id }).map((event) => event.sequence), [0, 1, 2, 3, 4]);
  assert.deepEqual(searchTrace(trace, { task: "install guide" }).length, 5);
  assert.deepEqual(searchTrace(trace, { task: "unrelated task" }), []);
  assert.deepEqual(searchTrace(trace, { stage: "decision", status: "ok" }).map((event) => event.sequence), [1, 4]);
  assert.equal(matchesEvent(trace, trace.events[0]!, { stage: "context" }), true);
});

test("the summary counts stages and statuses and links every result and receipt", () => {
  const summary = summaryOf(traceFixture());
  assert.equal(summary.events, 5);
  assert.equal(summary.receipts, 3);
  assert.deepEqual(summary.stages.filter((row) => row.events > 0), [
    { stage: "context", events: 1 },
    { stage: "edit", events: 1 },
    { stage: "verify", events: 1 },
    { stage: "decision", events: 2 },
  ]);
  assert.deepEqual(summary.statuses.filter((row) => row.events > 0), [
    { status: "ok", events: 4 },
    { status: "failed", events: 1 },
  ]);
  assert.deepEqual(summary.evidence, ["pack/install.json", "install.proof.json"]);
  assert.equal(compactSummary(summary).stages.length, 4);
  assert.equal(compactSummary(summary).statuses.length, 2);
});

test("a summary carries the truncation warning of a bounded trace", () => {
  const trace = longTraceFixture(20);
  const bounded = boundTrace(trace, { maxEvents: 6, maxBytes: 100_000 }).trace;
  const summary = summaryOf(bounded);
  assert.ok(summary.truncation);
  assert.equal(compactSummary(summary).truncation?.droppedEvents, 14);
});
