import assert from "node:assert/strict";
import { test } from "node:test";
import type { TaskDocument } from "../src/contracts/task.ts";
import { registerTask } from "../src/tasks/register.ts";
import { checkStart, overlappingOwnership, ownershipOf } from "../src/coordination/ownership.ts";
import { splitSubtasks } from "../src/coordination/split.ts";

/** A registered parent task with fixed hashes, so ids are deterministic. */
function parentTask(): TaskDocument {
  const result = registerTask(
    {
      version: 1,
      idempotencyKey: "parent-install",
      goal: "Update the install guide and its example",
      scope: { pages: ["guide/install"], files: ["examples/install.md"] },
      snapshot: {
        content: "a".repeat(64),
        data: "b".repeat(64),
        config: "c".repeat(64),
        tooling: "d".repeat(64),
      },
      budget: { contextTokens: 1000, toolCalls: 20, timeMs: 60_000 },
      permissions: { read: ["agent-parent"], write: ["agent-parent"], check: ["agent-parent"] },
      acceptance: [{ id: "guide-built", statement: "The guide builds.", check: "check.build" }],
    },
    { checks: ["check.build"] },
  );
  assert.ok(result.task);
  return result.task;
}

const subtasks = [
  {
    key: "guide",
    owner: "agent-guide",
    goal: "Rewrite the install steps",
    scope: { pages: ["guide/install"], blocks: ["install-steps"] },
    acceptance: [{ id: "guide-check", statement: "The guide builds.", check: "check.build" }],
    budget: { contextTokens: 500, toolCalls: 10, timeMs: 30_000 },
  },
  {
    key: "example",
    owner: "agent-example",
    goal: "Update the install example",
    scope: { files: ["examples/install.md"] },
    acceptance: [{ id: "example-review", statement: "A person reviewed it.", review: true }],
    dependsOn: ["guide"],
    budget: { contextTokens: 400, toolCalls: 8, timeMs: 20_000 },
  },
];

test("a split gives every part an owner, its own scope, acceptance, and a dependency order", () => {
  const result = splitSubtasks(parentTask(), subtasks);
  assert.deepEqual(result.problems, []);
  const plan = result.plan!;
  assert.equal(plan.subtasks.length, 2);
  assert.deepEqual(plan.subtasks.map((row) => row.owner), ["agent-example", "agent-guide"]);
  assert.deepEqual(plan.order.map((id) => plan.subtasks.find((row) => row.id === id)?.key), ["guide", "example"]);
  const example = plan.subtasks.find((row) => row.key === "example")!;
  const guide = plan.subtasks.find((row) => row.key === "guide")!;
  assert.deepEqual(example.dependsOn, [guide.id]);
  assert.deepEqual(example.permissions, {
    read: ["agent-parent"],
    write: ["agent-example"],
    check: ["agent-example"],
  });
});

test("the same split gives the same bytes whatever order the caller uses", () => {
  const forward = splitSubtasks(parentTask(), subtasks).plan!;
  const reversed = splitSubtasks(parentTask(), [...subtasks].reverse()).plan!;
  assert.deepEqual(reversed, forward);
  assert.equal(
    forward.subtasks[0]!.id,
    splitSubtasks(parentTask(), subtasks).plan!.subtasks[0]!.id,
  );
});

test("a dependency cycle and an unknown dependency are refused at split time", () => {
  const cycle = splitSubtasks(parentTask(), [
    { ...subtasks[0]!, dependsOn: ["example"] },
    { ...subtasks[1]!, dependsOn: ["guide"] },
  ]);
  assert.deepEqual(cycle.problems.map((problem) => problem.code), ["coordination.dependency-cycle"]);

  const unknown = splitSubtasks(parentTask(), [subtasks[1]!]);
  assert.deepEqual(unknown.problems.map((problem) => problem.code), ["coordination.dependency-unknown"]);
});

test("a split refuses a repeated scope, a missing owner, and a budget larger than the parent", () => {
  const repeated = splitSubtasks(parentTask(), [subtasks[0]!, { ...subtasks[1]!, scope: { pages: ["guide/install"], blocks: ["install-steps"] } }]);
  assert.ok(repeated.problems.some((problem) => problem.code === "coordination.scope-duplicate"));

  const missingOwner = splitSubtasks(parentTask(), [{ ...subtasks[0]!, owner: " " }]);
  assert.ok(missingOwner.problems.some((problem) => problem.code === "coordination.text"));

  const tooBig = splitSubtasks(parentTask(), [
    { ...subtasks[0]!, budget: { contextTokens: 5000, toolCalls: 10, timeMs: 30_000 } },
  ]);
  assert.ok(tooBig.problems.some((problem) => problem.code === "coordination.budget-parent"));

  assert.deepEqual(splitSubtasks(parentTask(), []).problems.map((problem) => problem.code), ["coordination.subtasks-empty"]);
});

test("ownership names every page, block, symbol, record, and file a subtask writes", () => {
  const plan = splitSubtasks(parentTask(), subtasks).plan!;
  assert.deepEqual(
    ownershipOf(plan.subtasks).map((row) => [row.kind, row.ref]),
    [["block", "install-steps"], ["file", "examples/install.md"], ["page", "guide/install"]],
  );
});

test("two overlapping writers are blocked before both start", () => {
  const overlapping = [
    subtasks[0]!,
    {
      ...subtasks[1]!,
      scope: { records: ["blog/install"], files: ["examples/install.md"] },
    },
    {
      key: "records",
      owner: "agent-records",
      goal: "Refresh the install record",
      scope: { records: ["blog/install"] },
      acceptance: [{ id: "record-check", statement: "The record builds.", check: "check.build" }],
      budget: { contextTokens: 100, toolCalls: 1, timeMs: 1000 },
    },
  ];
  const plan = splitSubtasks(parentTask(), overlapping).plan!;
  const guide = plan.subtasks.find((row) => row.key === "guide")!;
  const example = plan.subtasks.find((row) => row.key === "example")!;
  const records = plan.subtasks.find((row) => row.key === "records")!;

  assert.deepEqual(
    overlappingOwnership(plan.subtasks).map((row) => row.ref),
    ["blog/install"],
  );
  const blocked = checkStart(plan, records.id, [example.id]);
  assert.equal(blocked.ready, false);
  assert.equal(blocked.blockers[0]?.code, "coordination.scope-overlap");
  assert.equal(blocked.blockers[0]?.other, example.id);

  assert.equal(checkStart(plan, guide.id, [example.id]).ready, true);
  assert.equal(checkStart(plan, "missing", []).blockers[0]?.code, "coordination.not-ready");
});
