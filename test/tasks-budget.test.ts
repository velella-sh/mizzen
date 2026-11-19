import assert from "node:assert/strict";
import { test } from "node:test";
import { budgetStops, withinBudget } from "../src/tasks/budget.ts";

const budget = { contextTokens: 6000, toolCalls: 20, timeMs: 60000 };
const usage = { contextTokens: 6000, toolCalls: 20, timeMs: 60000 };

test("a run at or under every limit has no stop", () => {
  assert.deepEqual(budgetStops(budget, usage), []);
  assert.equal(withinBudget(budget, usage), true);
  assert.equal(withinBudget(budget, { contextTokens: 0, toolCalls: 0, timeMs: 0 }), true);
});

test("each limit has its own status and reason", () => {
  assert.deepEqual(budgetStops(budget, { ...usage, contextTokens: 6001 }), [
    {
      status: "context-tokens-exceeded",
      reason: "Context tokens spent (6001) exceed the limit (6000).",
    },
  ]);
  assert.deepEqual(budgetStops(budget, { ...usage, toolCalls: 21 }), [
    {
      status: "tool-calls-exceeded",
      reason: "Tool calls made (21) exceed the limit (20).",
    },
  ]);
  assert.deepEqual(budgetStops(budget, { ...usage, timeMs: 60001 }), [
    {
      status: "time-exceeded",
      reason: "Time spent (60001 ms) exceeds the limit (60000 ms).",
    },
  ]);
});

test("several exceeded limits keep the fixed context, tools, time order", () => {
  const stops = budgetStops(budget, { contextTokens: 7000, toolCalls: 30, timeMs: 90000 });
  assert.deepEqual(stops.map((stop) => stop.status), [
    "context-tokens-exceeded",
    "tool-calls-exceeded",
    "time-exceeded",
  ]);
  assert.equal(withinBudget(budget, { contextTokens: 7000, toolCalls: 0, timeMs: 0 }), false);
});

test("a zero limit stops at the first spend of that kind only", () => {
  const zero = { contextTokens: 0, toolCalls: 0, timeMs: 0 };
  assert.deepEqual(budgetStops(zero, { contextTokens: 1, toolCalls: 0, timeMs: 0 }).map((stop) => stop.status), [
    "context-tokens-exceeded",
  ]);
  assert.deepEqual(budgetStops(zero, { contextTokens: 0, toolCalls: 1, timeMs: 0 }).map((stop) => stop.status), [
    "tool-calls-exceeded",
  ]);
  assert.deepEqual(budgetStops(zero, { contextTokens: 0, toolCalls: 0, timeMs: 1 }).map((stop) => stop.status), [
    "time-exceeded",
  ]);
});
