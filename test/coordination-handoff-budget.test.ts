import assert from "node:assert/strict";
import { test } from "node:test";
import type { InteractionCheckpoint } from "../src/contracts/interaction.ts";
import { acceptHandoff, handoffSubtask, shouldApplyHandoff } from "../src/coordination/handoff.ts";
import { createLease } from "../src/coordination/lease.ts";
import { sharedBudgetReport, reconcileBudget } from "../src/coordination/budget.ts";
import { traceUsage } from "../src/trace/cost.ts";
import { traceFixture } from "./trace-fixture.ts";
import { fixturePlan, subtaskOf } from "./coordination-fixture.ts";

const plan = fixturePlan();
const guide = subtaskOf(plan, "guide");
const lease = createLease({
  subtask: guide.id,
  owner: "agent-guide",
  scope: guide.scope,
  snapshot: plan.parent.snapshot,
  nowMs: 1_000,
  ttlMs: 60_000,
}).lease!;

const checkpoint: InteractionCheckpoint = {
  taskId: guide.id,
  snapshot: plan.parent.snapshot,
  policy: "policy.write",
  stage: "edit",
  evidence: "guide.pack.json",
  next: "edit.apply",
  applied: ["tx-1", "tx-2"],
};

test("a replacement receives the checkpoint, transferred lease, pack, checks, and applied work", () => {
  const result = handoffSubtask({
    lease,
    from: "agent-guide",
    to: "agent-next",
    checkpoint,
    pack: "guide.pack.json",
    checks: [{ id: "guide-check", status: "passed", evidence: "guide.proof.json" }],
    nowMs: 2_000,
    ttlMs: 30_000,
  });
  assert.deepEqual(result.problems, []);
  const handoff = result.handoff!;
  assert.equal(handoff.lease.owner, "agent-next");
  assert.equal(handoff.lease.subtask, guide.id);
  assert.equal(handoff.lease.generation, 0);
  assert.deepEqual(handoff.applied, ["tx-1", "tx-2"]);
  assert.equal(handoff.status, "ready");
  assert.equal(handoff.pack, "guide.pack.json");
  assert.equal(shouldApplyHandoff(handoff, "tx-1"), false);
  assert.equal(shouldApplyHandoff(handoff, "tx-3"), true);

  const resume = acceptHandoff(handoff, { owner: "agent-next", nowMs: 3_000 }).resume!;
  assert.equal(resume.next, "edit.apply");
  assert.deepEqual(resume.skip, ["tx-1", "tx-2"]);
  assert.equal(resume.pack, "guide.pack.json");
  assert.equal(resume.status, "ready");
});

test("a handoff refuses the wrong owner, a self-handoff, an expired lease, and a mismatched checkpoint", () => {
  const base = {
    lease,
    from: "agent-guide",
    to: "agent-next",
    checkpoint,
    pack: "guide.pack.json",
    checks: [],
    nowMs: 2_000,
    ttlMs: 30_000,
  };
  assert.deepEqual(handoffSubtask({ ...base, from: "agent-other" }).problems.map((p) => p.code).sort(), [
    "coordination.handoff-owner",
  ]);
  assert.ok(handoffSubtask({ ...base, to: "agent-guide" }).problems.some((p) => p.code === "coordination.handoff-self"));
  assert.ok(handoffSubtask({ ...base, nowMs: 61_000 }).problems.some((p) => p.code === "coordination.handoff-expired"));
  assert.ok(handoffSubtask({ ...base, pack: " " }).problems.some((p) => p.code === "coordination.handoff-pack"));
  assert.ok(handoffSubtask({ ...base, ttlMs: 0 }).problems.some((p) => p.code === "coordination.handoff-ttl"));
  assert.ok(handoffSubtask({ ...base, checkpoint: { ...checkpoint, taskId: "other" } }).problems.some((p) => p.code === "coordination.handoff-checkpoint"));
  assert.ok(handoffSubtask({ ...base, checkpoint: { ...checkpoint, snapshot: "0".repeat(64) } }).problems.some((p) => p.code === "coordination.handoff-snapshot"));
  assert.ok(handoffSubtask({ ...base, from: "*" }).problems.some((p) => p.code === "coordination.handoff-principal"));
});

test("a failed check blocks the replacement, and acceptance refuses another agent or an expired lease", () => {
  const handoff = handoffSubtask({
    lease,
    from: "agent-guide",
    to: "agent-next",
    checkpoint,
    pack: "guide.pack.json",
    checks: [{ id: "guide-check", status: "failed" }],
    nowMs: 2_000,
    ttlMs: 30_000,
  }).handoff!;
  assert.equal(handoff.status, "blocked");
  assert.deepEqual(acceptHandoff(handoff, { owner: "agent-other", nowMs: 3_000 }).problems.map((p) => p.code), [
    "coordination.resume-owner",
  ]);
  assert.deepEqual(acceptHandoff(handoff, { owner: "agent-next", nowMs: 32_000 }).problems.map((p) => p.code), [
    "coordination.resume-expired",
  ]);
});

test("the shared report adds subtasks and reports every exceeded parent limit", () => {
  const report = sharedBudgetReport(plan, [
    { subtask: "b", usage: { contextTokens: 80, toolCalls: 3, timeMs: 2_000 } },
    { subtask: "a", usage: { contextTokens: 120, toolCalls: 2, timeMs: 1_000 } },
  ]);
  assert.deepEqual(report.rows.map((row) => row.subtask), ["a", "b"]);
  assert.deepEqual(report.total, { contextTokens: 200, toolCalls: 5, timeMs: 3_000 });
  assert.equal(report.within, true);
  assert.deepEqual(report.stops, []);

  const tight = sharedBudgetReport({ ...plan, parent: { ...plan.parent, budget: { contextTokens: 100, toolCalls: 4, timeMs: 2_000 } } }, [
    { subtask: "a", usage: { contextTokens: 120, toolCalls: 2, timeMs: 1_000 } },
    { subtask: "b", usage: { contextTokens: 80, toolCalls: 3, timeMs: 2_000 } },
  ]);
  assert.deepEqual(tight.stops.map((stop) => stop.status), [
    "context-tokens-exceeded",
    "tool-calls-exceeded",
    "time-exceeded",
  ]);
  assert.equal(tight.within, false);
});

test("the report totals agree with the trace, or say exactly where they differ", () => {
  const usage = traceUsage(traceFixture());
  const rows = usage.subtasks.map((row) => ({
    subtask: row.subtask,
    usage: {
      contextTokens: row.contextTokens + row.refillTokens,
      toolCalls: row.toolCalls,
      timeMs: 0,
    },
  }));
  const report = sharedBudgetReport(plan, rows);
  const withTime = { ...report, total: { ...report.total, timeMs: usage.timeMs } };
  assert.deepEqual(reconcileBudget(withTime, usage), []);

  const wrong = { ...withTime, total: { ...withTime.total, toolCalls: 99 } };
  assert.ok(reconcileBudget(wrong, usage).some((problem) => problem.code === "coordination.budget-total"));

  const missing = { ...withTime, rows: withTime.rows.slice(1) };
  assert.ok(reconcileBudget(missing, usage).some((problem) => problem.code === "coordination.budget-trace"));
});
