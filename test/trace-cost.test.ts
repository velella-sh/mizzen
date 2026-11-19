import assert from "node:assert/strict";
import { test } from "node:test";
import { TraceRecorder } from "../src/trace/record.ts";
import { traceBudgetStops, traceUsage, usageProblems } from "../src/trace/cost.ts";
import { FIXTURE_SNAPSHOT, FIXTURE_TASK, traceFixture } from "./trace-fixture.ts";

test("cost is summed per subtask in first-appearance order, and the total is every row", () => {
  const usage = traceUsage(traceFixture());
  assert.deepEqual(usage.subtasks, [
    { subtask: "research", contextTokens: 100, refillTokens: 20, toolCalls: 2 },
    { subtask: "write", contextTokens: 50, refillTokens: 0, toolCalls: 1 },
    { subtask: "verify", contextTokens: 10, refillTokens: 5, toolCalls: 2 },
  ]);
  assert.deepEqual(usage.total, { contextTokens: 160, refillTokens: 25, toolCalls: 5 });
  assert.equal(usage.toolCalls, 5);
  assert.equal(usage.timeMs, 10 + 25 + 8);
});

test("an event without a recorded cost still counts as one tool call", () => {
  const recorder = new TraceRecorder({ task: FIXTURE_TASK, snapshot: FIXTURE_SNAPSHOT });
  recorder.append({ stage: "verify", kind: "verify", capability: "edit.verify", status: "ok" });
  const usage = traceUsage(recorder.document());
  assert.deepEqual(usage.total, { contextTokens: 0, refillTokens: 0, toolCalls: 1 });
  assert.equal(usage.subtasks[0]?.subtask, "unassigned");
});

test("the trace totals agree with a task report, and a mismatch names both numbers", () => {
  const trace = traceFixture();
  assert.deepEqual(usageProblems(trace, { contextTokens: 185, toolCalls: 5, timeMs: 43 }), []);
  const [context] = usageProblems(trace, { contextTokens: 184, toolCalls: 5, timeMs: 43 });
  assert.ok(context);
  assert.equal(context.code, "trace.cost-report");
  assert.match(context.message, /185 context tokens.*184/);
  const [calls] = usageProblems(trace, { contextTokens: 185, toolCalls: 4, timeMs: 43 });
  assert.ok(calls);
  assert.match(calls.message, /5 tool calls.*4/);
});

test("the trace stops on every independent budget it exceeds, in the task order", () => {
  const stops = traceBudgetStops(traceFixture(), { contextTokens: 100, toolCalls: 2, timeMs: 10 });
  assert.deepEqual(stops.map((stop) => stop.status), ["context-tokens-exceeded", "tool-calls-exceeded", "time-exceeded"]);
  assert.deepEqual(traceBudgetStops(traceFixture(), { contextTokens: 185, toolCalls: 5, timeMs: 43 }), []);
});
