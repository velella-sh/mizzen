import assert from "node:assert/strict";
import { test } from "node:test";
import type { CoordinationSubtask } from "../src/contracts/coordination.ts";
import { decideDuplicate, duplicateSubtasks } from "../src/coordination/duplicate.ts";
import { scheduleSubtasks } from "../src/coordination/schedule.ts";
import { fixturePlan, subtaskOf } from "./coordination-fixture.ts";

const plan = fixturePlan();
const guide = subtaskOf(plan, "guide");
const example = subtaskOf(plan, "example");

test("a dependent subtask is not ready before its prerequisite has evidence", () => {
  assert.deepEqual(
    scheduleSubtasks(plan, []).map((row) => [row.subtask, row.state]),
    [[guide.id, "ready"], [example.id, "waiting"]],
  );
  const ready = scheduleSubtasks(plan, [
    { subtask: guide.id, snapshot: plan.parent.snapshot, proof: "guide.proof.json", checks: [{ id: "guide-check", status: "passed" }], applied: ["tx-1"] },
  ]);
  assert.deepEqual(ready.map((row) => [row.subtask, row.state]), [[guide.id, "done"], [example.id, "ready"]]);
});

test("evidence from another snapshot or with a failed check never unblocks a dependent", () => {
  const mismatched = scheduleSubtasks(plan, [
    { subtask: guide.id, snapshot: "0".repeat(64), proof: "guide.proof.json", checks: [], applied: [] },
  ]);
  assert.equal(mismatched[0]?.state, "failed");
  assert.equal(mismatched[1]?.state, "waiting");
  assert.equal(mismatched[1]?.missing[0], guide.id);

  const failed = scheduleSubtasks(plan, [
    { subtask: guide.id, snapshot: plan.parent.snapshot, proof: "guide.proof.json", checks: [{ id: "guide-check", status: "failed" }], applied: [] },
  ]);
  assert.equal(failed[0]?.state, "done");
  assert.equal(failed[1]?.state, "blocked");
  assert.match(failed[1]?.reason ?? "", /guide-check/);

  const emptyProof = scheduleSubtasks(plan, [
    { subtask: guide.id, snapshot: plan.parent.snapshot, proof: " ", checks: [], applied: [] },
  ]);
  assert.deepEqual(emptyProof.map((row) => row.state), ["ready", "waiting"]);
});

test("duplicate work needs the same goal, snapshot, and scope, with reasons for each", () => {
  const duplicate: CoordinationSubtask = {
    ...guide,
    id: "0".repeat(64),
    key: "guide-copy",
    owner: "agent-copy",
    goal: "rewrite   the install STEPS",
  };
  const matches = duplicateSubtasks([guide, duplicate]);
  assert.equal(matches.length, 1);
  assert.deepEqual(matches[0]?.reasons, ["goal", "snapshot", "scope"]);
  assert.match(matches[0]?.message ?? "", /merge them or keep them separate/);

  assert.deepEqual(duplicateSubtasks([guide, { ...duplicate, goal: "Update an unrelated page" }]), []);
  assert.deepEqual(duplicateSubtasks([guide, { ...duplicate, snapshot: "1".repeat(64) }]), []);
  assert.deepEqual(duplicateSubtasks([guide, { ...duplicate, scope: { pages: [], blocks: [], symbols: [], records: [], files: ["other.md"] } }]), []);
});

test("a duplicate decision is explicit and carries a reason", () => {
  const match = duplicateSubtasks([guide, { ...guide, id: "0".repeat(64), key: "copy", owner: "other" }])[0]!;
  assert.equal(decideDuplicate(match, "merge", " ").problems[0]?.code, "coordination.duplicate-reason");
  assert.deepEqual(decideDuplicate(match, "merge", " one change ").decision, {
    version: 1,
    subtask: match.subtask,
    other: match.other,
    choice: "merge",
    reason: "one change",
  });
  assert.equal(decideDuplicate(match, "keep-separate", "different reviewers").decision?.choice, "keep-separate");
});
