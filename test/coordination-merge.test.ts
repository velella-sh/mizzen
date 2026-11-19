import assert from "node:assert/strict";
import { test } from "node:test";
import type { CoordinationFileResult, CoordinationSubtaskResult } from "../src/contracts/coordination.ts";
import { escalateMerge, resolveEscalation } from "../src/coordination/escalate.ts";
import { mergeSubtaskResults } from "../src/coordination/merge.ts";
import { fixturePlan, subtaskOf } from "./coordination-fixture.ts";

const plan = fixturePlan();
const guide = subtaskOf(plan, "guide");
const example = subtaskOf(plan, "example");
const snapshot = plan.parent.snapshot;

/** One changed file from a fixed before hash to a fixed after hash. */
function file(name: string, before: string, after: string): CoordinationFileResult {
  return { file: name, beforeHash: before.repeat(64), afterHash: after.repeat(64) };
}

/** A result with its own diff. */
function result(
  subtask: string,
  files: readonly CoordinationFileResult[],
  diff: string,
  finishedAt: number,
): CoordinationSubtaskResult {
  return {
    subtask,
    snapshot,
    finishedAt,
    files,
    transactions: [`tx-${subtask.slice(0, 4)}`],
    evidence: [`${subtask.slice(0, 4)}.proof.json`],
    diff,
  };
}

test("merge order follows dependencies and is independent of finish time and input order", () => {
  const guideResult = result(guide.id, [file("guide/install.md", "a", "b")], "--- guide", 900);
  const exampleResult = result(example.id, [file("examples/install.md", "c", "d")], "--- example", 100);
  const first = mergeSubtaskResults(plan, [guideResult, exampleResult]);
  const second = mergeSubtaskResults(plan, [
    { ...exampleResult, finishedAt: 1_000_000 },
    { ...guideResult, finishedAt: 0 },
  ]);
  assert.deepEqual(first.conflicts, []);
  assert.deepEqual(first, second);
  assert.deepEqual(first.order.map((entry) => entry.subtask), plan.order);
  assert.deepEqual(first.files, [
    { file: "examples/install.md", hash: "d".repeat(64) },
    { file: "guide/install.md", hash: "b".repeat(64) },
  ]);
});

test("a dependent result chains from the prerequisite's hash", () => {
  const shared = "1".repeat(64);
  const guideResult = result(guide.id, [file("guide/install.md", "a", "b")], "--- guide", 2);
  const exampleResult = result(example.id, [{ file: "guide/install.md", beforeHash: "b".repeat(64), afterHash: shared }], "--- example", 1);
  const merge = mergeSubtaskResults(plan, [exampleResult, guideResult]);
  assert.deepEqual(merge.conflicts, []);
  assert.deepEqual(merge.files, [{ file: "guide/install.md", hash: shared }]);
  assert.deepEqual(merge.order.map((entry) => entry.subtask), [guide.id, example.id]);
});

test("two independent edits of one file are a conflict, not last-writer-wins", () => {
  const guideResult = result(guide.id, [file("guide/install.md", "a", "b")], "--- guide diff", 1);
  const exampleResult = result(example.id, [file("guide/install.md", "a", "c")], "--- example diff", 999);
  const merge = mergeSubtaskResults(plan, [exampleResult, guideResult]);
  assert.deepEqual(merge.conflicts.map((conflict) => [conflict.kind, conflict.file]), [["stale-before", "guide/install.md"]]);
  assert.deepEqual(merge.files, [{ file: "guide/install.md", hash: "b".repeat(64) }]);

  const escalation = escalateMerge({ merge, results: [guideResult, exampleResult], target: "parent" }).escalation!;
  assert.equal(escalation.status, "open");
  assert.equal(escalation.decision, undefined);
  assert.deepEqual(escalation.sides.map((side) => side.subtask).sort(), [guide.id, example.id].sort());
  assert.deepEqual(escalation.sides.map((side) => side.diff).sort(), ["--- example diff", "--- guide diff"]);
  assert.equal(escalation.sides.length, 2);

  const resolved = resolveEscalation(escalation, "left", "the example keeps the URL").escalation!;
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.decision?.subtask, escalation.sides[0]?.subtask);
  assert.equal(resolved.decision?.reason, "the example keeps the URL");
});

test("escalation and resolution refuse an empty decision path", () => {
  const guideResult = result(guide.id, [file("guide/install.md", "a", "b")], "--- guide", 1);
  const exampleResult = result(example.id, [file("examples/install.md", "c", "d")], "--- example", 2);
  const clean = mergeSubtaskResults(plan, [guideResult, exampleResult]);
  assert.deepEqual(escalateMerge({ merge: clean, results: [], target: "human" }).problems.map((p) => p.code), [
    "coordination.escalation-empty",
  ]);

  const conflictMerge = mergeSubtaskResults(plan, [
    guideResult,
    result(example.id, [file("guide/install.md", "a", "c")], "--- other", 3),
  ]);
  const escalation = escalateMerge({ merge: conflictMerge, results: [guideResult], target: "human" }).escalation!;
  assert.equal(escalation.sides.length, 1);
  assert.deepEqual(resolveEscalation(escalation, "left", "ok").problems.map((p) => p.code), [
    "coordination.escalation-sides",
  ]);
  assert.deepEqual(resolveEscalation(escalation, "left", " ").problems.map((p) => p.code), [
    "coordination.escalation-sides",
    "coordination.escalation-reason",
  ]);
  const done = resolveEscalation(
    escalateMerge({
      merge: conflictMerge,
      results: [guideResult, result(example.id, [file("guide/install.md", "a", "c")], "--- other", 3)],
      target: "human",
    }).escalation!,
    "left",
    "chosen",
  ).escalation!;
  assert.deepEqual(resolveEscalation(done, "right", "again").problems.map((p) => p.code), [
    "coordination.escalation-closed",
  ]);
});

test("unknown, duplicate, missing, snapshot, and repeated-file results are reported", () => {
  const good = result(guide.id, [file("guide/install.md", "a", "b")], "--- guide", 1);
  const merge = mergeSubtaskResults(plan, [
    good,
    { ...good },
    { ...good, subtask: "unknown" },
    { ...good, subtask: example.id, snapshot: "0".repeat(64) },
  ]);
  assert.deepEqual(
    merge.conflicts.map((conflict) => conflict.kind).sort(),
    ["duplicate-result", "missing-result", "snapshot", "unknown-result"],
  );
  assert.equal(merge.conflicts.some((conflict) => conflict.kind === "missing-result" && conflict.subtasks[0] === example.id), true);

  const repeated = result(guide.id, [file("guide/install.md", "a", "b"), file("guide/install.md", "a", "c")], "--- guide", 1);
  const repeatedMerge = mergeSubtaskResults(plan, [repeated]);
  assert.equal(repeatedMerge.conflicts.some((conflict) => conflict.kind === "same-file" && conflict.subtasks[0] === guide.id), true);
});
