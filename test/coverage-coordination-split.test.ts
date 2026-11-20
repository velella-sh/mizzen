import assert from "node:assert/strict";
import { test } from "node:test";
import { splitSubtasks } from "../src/coordination/split.ts";
import { fixtureParent } from "./coordination-fixture.ts";

const parent = fixtureParent();

/** One valid subtask, with the fields a test overrides. */
function subtask(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: "guide",
    owner: "agent-guide",
    goal: "Rewrite the install steps",
    scope: { pages: ["guide/install"] },
    acceptance: [{ id: "guide-check", statement: "The guide builds.", check: "check.build" }],
    budget: { contextTokens: 500, toolCalls: 10, timeMs: 30_000 },
    ...extra,
  };
}

/** The codes a split reports for `input`. */
function codes(input: readonly unknown[]): string[] {
  return splitSubtasks(parent, input).problems.map((problem) => problem.code);
}

test("a split reports every malformed subtask shape and field", () => {
  const results = [
    codes([null]),
    codes([[]]),
    codes(["guide"]),
    codes([{ ...subtask(), key: 7 }]),
    codes([{ ...subtask(), key: "  " }]),
    codes([{ ...subtask(), owner: "*" }]),
    codes([{ ...subtask(), goal: undefined }]),
    codes([{ ...subtask(), scope: null }]),
    codes([{ ...subtask(), scope: "guide/install" }]),
    codes([{ ...subtask(), scope: {} }]),
    codes([{ ...subtask(), scope: { pages: "guide/install" } }]),
    codes([{ ...subtask(), scope: { pages: [1] } }]),
    codes([{ ...subtask(), scope: { pages: ["guide/install", "guide/install"] } }]),
    codes([{ ...subtask(), scope: { pages: [" "] } }]),
    codes([{ ...subtask(), acceptance: [] }]),
    codes([{ ...subtask(), acceptance: "check" }]),
    codes([{ ...subtask(), acceptance: [null] }]),
    codes([
      {
        ...subtask(),
        acceptance: [
          { id: "same", statement: "One.", check: "check.build" },
          { id: "same", statement: "Two.", review: true },
        ],
      },
    ]),
    codes([
      {
        ...subtask(),
        acceptance: [{ id: "both", statement: "Both.", check: "check.build", review: true }],
      },
    ]),
    codes([{ ...subtask(), acceptance: [{ id: "neither", statement: "Neither." }] }]),
    codes([{ ...subtask(), budget: null }]),
    codes([{ ...subtask(), budget: { contextTokens: -1, toolCalls: 10, timeMs: 10 } }]),
    codes([{ ...subtask(), budget: { contextTokens: 1.5, toolCalls: 10, timeMs: 10 } }]),
    codes([{ ...subtask(), budget: { contextTokens: "10", toolCalls: 10, timeMs: 10 } }]),
    codes([{ ...subtask(), dependsOn: "example" }]),
  ];
  const expected = [
    ["coordination.subtask-shape"],
    ["coordination.subtask-shape"],
    ["coordination.subtask-shape"],
    ["coordination.text"],
    ["coordination.text"],
    ["coordination.owner-wildcard"],
    ["coordination.text"],
    ["coordination.scope-shape"],
    ["coordination.scope-shape"],
    ["coordination.scope-empty"],
    ["coordination.list"],
    ["coordination.list-entry"],
    ["coordination.duplicate"],
    ["coordination.list-entry"],
    ["coordination.acceptance-empty"],
    ["coordination.acceptance-empty"],
    ["coordination.acceptance-shape"],
    ["coordination.acceptance-duplicate"],
    ["coordination.acceptance-mode"],
    ["coordination.acceptance-mode"],
    ["coordination.budget-shape"],
    ["coordination.budget"],
    ["coordination.budget"],
    ["coordination.budget"],
    ["coordination.depends-shape"],
  ];
  assert.deepEqual(results, expected);
});

test("a split refuses a repeated key and a self dependency, naming the offending part", () => {
  const duplicate = splitSubtasks(parent, [
    subtask(),
    subtask({ owner: "agent-other", scope: { files: ["examples/install.md"] } }),
  ]);
  assert.deepEqual(duplicate.problems.map((problem) => problem.code), ["coordination.key-duplicate"]);
  assert.equal(duplicate.problems[0]?.path, "/subtasks/1/key");

  const self = splitSubtasks(parent, [subtask({ dependsOn: ["guide"] })]);
  assert.deepEqual(self.problems.map((problem) => problem.code), [
    "coordination.dependency-self",
    "coordination.dependency-cycle",
  ]);
  assert.equal(self.problems[0]?.path, "/subtasks/guide/dependsOn");
});

test("a scope may be reordered and still count as the same scope", () => {
  const repeated = splitSubtasks(parent, [
    subtask({ scope: { pages: ["guide/install", "guide/other"], files: ["a.md"] } }),
    subtask({
      key: "other",
      owner: "agent-other",
      goal: "Do the other part",
      scope: { files: ["a.md"], pages: ["guide/other", "guide/install"] },
    }),
  ]);
  assert.deepEqual(repeated.problems.map((problem) => problem.code), ["coordination.scope-duplicate"]);
});

test("a valid split still returns a plan and sorts dependencies by id", () => {
  const result = splitSubtasks(parent, [
    subtask(),
    subtask({
      key: "example",
      owner: "agent-example",
      goal: "Update the example",
      scope: { files: ["examples/install.md"] },
      acceptance: [{ id: "review", statement: "A person reviewed it.", review: true }],
      dependsOn: ["guide"],
      budget: { contextTokens: 10, toolCalls: 1, timeMs: 100 },
    }),
  ]);
  assert.deepEqual(result.problems, []);
  assert.equal(result.plan?.version, 1);
  assert.deepEqual(result.plan?.order.length, 2);
  assert.equal(result.plan?.subtasks.find((row) => row.key === "example")?.dependsOn.length, 1);
});
