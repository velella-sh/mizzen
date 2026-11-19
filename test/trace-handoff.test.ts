import assert from "node:assert/strict";
import { test } from "node:test";
import { handoffOf } from "../src/trace/handoff.ts";
import { boundTrace } from "../src/trace/retain.ts";
import { longTraceFixture, traceFixture } from "./trace-fixture.ts";

test("a handoff names the state, the changes, every decision, and the unfinished work", () => {
  const handoff = handoffOf(traceFixture());
  assert.equal(handoff.state, "ok");
  assert.deepEqual(handoff.task.goal, "Update the install guide");
  assert.deepEqual(handoff.changes.map((receipt) => receipt.reference), ["install.proof.json"]);
  assert.deepEqual(
    handoff.decisions.map((decision) => [decision.sequence, decision.kind, decision.policy]),
    [[1, "decision", "policy.context-source"], [4, "approval", "policy.proof-required"]],
  );
  assert.match(handoff.decisions[0]?.reason ?? "", /source of truth/);
  assert.deepEqual(
    handoff.remaining.map((item) => [item.sequence, item.capability, item.status]),
    [[3, "edit.verify", "failed"]],
  );
  assert.equal(handoff.receipts.length, 3);
  assert.equal(handoff.truncation, undefined);
});

test("a bounded trace hands off the same warning it carries", () => {
  const trace = longTraceFixture(20);
  const bounded = boundTrace(trace, { maxEvents: 6, maxBytes: 100_000 }).trace;
  const handoff = handoffOf(bounded);
  assert.ok(handoff.truncation);
  assert.equal(handoff.truncation?.droppedEvents, 14);
  assert.match(handoff.truncation?.summary ?? "", /Kept 6 of 20/);
});
