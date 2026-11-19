import assert from "node:assert/strict";
import { test } from "node:test";
import type { CoordinationPlan } from "../src/contracts/coordination.ts";
import { aggregateEvidence } from "../src/coordination/evidence.ts";
import { fixturePlan, subtaskOf } from "./coordination-fixture.ts";

const plan = fixturePlan();
const guide = subtaskOf(plan, "guide");
const example = subtaskOf(plan, "example");
const snapshot = plan.parent.snapshot;

test("each subtask keeps its own pack and proof under the parent's snapshot", () => {
  const aggregate = aggregateEvidence({
    plan,
    principal: "agent-parent",
    packs: [
      { subtask: guide.id, snapshot, pack: "guide.pack.json" },
      { subtask: example.id, snapshot, pack: "example.pack.json" },
    ],
    proofs: [
      { subtask: guide.id, snapshot, proof: "guide.proof.json", verdict: "proved", checks: [{ id: "guide-check", status: "passed" }] },
      { subtask: example.id, snapshot, proof: "example.proof.json", verdict: "incomplete", checks: [] },
    ],
  });
  assert.deepEqual(aggregate.problems, []);
  assert.deepEqual(aggregate.snapshots, [snapshot]);
  assert.deepEqual(
    aggregate.entries.map((entry) => [entry.subtask, entry.authorized, entry.pack, entry.proof]),
    plan.subtasks.map((row) => [
      row.id,
      true,
      row.id === guide.id ? "guide.pack.json" : "example.pack.json",
      row.id === guide.id ? "guide.proof.json" : "example.proof.json",
    ]),
  );
  assert.deepEqual(aggregate.entries.find((entry) => entry.subtask === guide.id)?.checks, [{ id: "guide-check", status: "passed" }]);
});

test("evidence from another snapshot is reported and never combined", () => {
  const other = "0".repeat(64);
  const aggregate = aggregateEvidence({
    plan,
    principal: "agent-parent",
    packs: [{ subtask: guide.id, snapshot: other, pack: "stale.pack.json" }],
    proofs: [{ subtask: guide.id, snapshot: other, proof: "stale.proof.json", verdict: "proved", checks: [] }],
  });
  assert.deepEqual(aggregate.problems.map((problem) => problem.code), [
    "coordination.aggregate-snapshot",
    "coordination.aggregate-snapshot",
  ]);
  assert.deepEqual(aggregate.snapshots, [other]);
  const entry = aggregate.entries.find((row) => row.subtask === guide.id)!;
  assert.equal(entry.pack, undefined);
  assert.equal(entry.proof, undefined);
  assert.deepEqual(entry.checks, []);
});

test("unknown evidence is refused, and an unauthorized parent reads none of it", () => {
  const unknown = aggregateEvidence({
    plan,
    principal: "agent-parent",
    packs: [{ subtask: "unknown", snapshot, pack: "x.json" }],
    proofs: [],
  });
  assert.deepEqual(unknown.problems.map((problem) => problem.code), ["coordination.aggregate-unknown"]);

  const denied = aggregateEvidence({
    plan,
    principal: "agent-stranger",
    packs: [{ subtask: "unknown", snapshot, pack: "x.json" }],
    proofs: [],
  });
  assert.deepEqual(denied.problems.map((problem) => problem.code), ["coordination.aggregate-unauthorized"]);
  assert.deepEqual(denied.entries, []);
  assert.equal(denied.problems[0]?.message.includes("x.json"), false);
});

test("a subtask the parent may not read is redacted, and duplicate packs are reported", () => {
  const restricted: CoordinationPlan = {
    ...plan,
    subtasks: plan.subtasks.map((row) =>
      row.id === guide.id ? { ...row, permissions: { ...row.permissions, read: ["agent-guide"] } } : row,
    ),
  };
  const aggregate = aggregateEvidence({
    plan: restricted,
    principal: "agent-parent",
    packs: [
      { subtask: guide.id, snapshot, pack: "guide-a.pack.json" },
      { subtask: guide.id, snapshot, pack: "guide-b.pack.json" },
    ],
    proofs: [],
  });
  const entry = aggregate.entries.find((row) => row.subtask === guide.id)!;
  assert.equal(entry.authorized, false);
  assert.equal(entry.goal, undefined);
  assert.equal(entry.pack, undefined);
  assert.equal(entry.checks.length, 0);
  assert.equal(aggregate.problems.length, 0);
});

test("a subtask pinned to another snapshot cannot feed this parent", () => {
  const moved: CoordinationPlan = {
    ...plan,
    subtasks: plan.subtasks.map((row) =>
      row.id === guide.id ? { ...row, snapshot: "1".repeat(64) } : row,
    ),
  };
  const aggregate = aggregateEvidence({
    plan: moved,
    principal: "agent-parent",
    packs: [{ subtask: guide.id, snapshot: "1".repeat(64), pack: "moved.pack.json" }],
    proofs: [],
  });
  assert.deepEqual(aggregate.problems.map((problem) => problem.code), ["coordination.aggregate-parent-snapshot"]);
  assert.equal(aggregate.entries.find((row) => row.subtask === guide.id)?.pack, undefined);
});
