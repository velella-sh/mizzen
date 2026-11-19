/**
 * The two-agent demo (#1204): a guide and an example edited in parallel.
 *
 * Agent A owns the guide page and its install block; agent B owns the example file. Their scopes
 * do not overlap, so both start, and their results merge in dependency order whatever order they
 * finish. A third attempt to claim the guide page while agent A holds it is rejected before it
 * starts. The merged files equal the files a strictly serial run produces.
 *
 * Everything is fixed: hashes, times, ids, and transaction names. The report is the same bytes on
 * every machine and is kept as `fixtures/coordination/two-agent.json`.
 */
import type { CoordinationSubtaskResult, CoordinationPlan } from "../contracts/coordination.ts";
import type { TaskDocument } from "../contracts/task.ts";
import { registerTask } from "../tasks/register.ts";
import { mergeSubtaskResults } from "./merge.ts";
import { checkStart } from "./ownership.ts";
import { splitSubtasks } from "./split.ts";

/** The deterministic result of the two-agent run. */
export interface TwoAgentDemo {
  readonly version: 1;
  readonly parent: string;
  /** The merge's dependency order. */
  readonly order: readonly string[];
  readonly parallel: {
    readonly merge: string;
    readonly files: readonly { readonly file: string; readonly hash: string | null }[];
  };
  readonly serial: {
    readonly files: readonly { readonly file: string; readonly hash: string | null }[];
  };
  /** True when parallel and serial produced identical files and merge ids. */
  readonly match: boolean;
  readonly conflict: {
    readonly blocked: boolean;
    readonly code: string;
    readonly subtasks: readonly string[];
    readonly message: string;
  };
}

/** Runs the demo and returns its deterministic report. */
export function runTwoAgentDemo(): TwoAgentDemo {
  const parent = demoParent();
  const split = splitSubtasks(parent, demoSubtasks());
  if (split.plan === undefined) throw new Error(`the demo plan is invalid: ${split.problems.map((problem) => problem.message).join(" ")}`);
  const plan = split.plan;
  const guide = plan.subtasks.find((row) => row.key === "guide")!;
  const example = plan.subtasks.find((row) => row.key === "example")!;

  // Both starts are clear because the scopes are disjoint.
  for (const subtask of [guide, example]) {
    const start = checkStart(plan, subtask.id, subtask.id === guide.id ? [] : [guide.id]);
    if (!start.ready) throw new Error(`the demo subtask ${subtask.key} cannot start: ${start.blockers.map((blocker) => blocker.message).join(" ")}`);
  }

  // A deliberate conflict: a third subtask claims the guide page while the guide subtask runs.
  const conflictPlan = splitSubtasks(parent, [
    demoSubtasks()[0]!,
    { ...demoSubtasks()[1]!, key: "guide-copy", owner: "agent-example", scope: { pages: ["guide/install"] }, dependsOn: [] },
  ]).plan!;
  const copy = conflictPlan.subtasks.find((row) => row.key === "guide-copy")!;
  const conflict = checkStart(conflictPlan, copy.id, [guide.id]);

  const results = demoResults(plan);
  const parallel = mergeSubtaskResults(plan, [...results].reverse());
  const serialMerge = mergeSubtaskResults(plan, results);
  const serial = applySequentially(plan, results);

  return {
    version: 1,
    parent: plan.parent.id,
    order: plan.order,
    parallel: { merge: parallel.id, files: parallel.files },
    serial: { files: serial },
    match:
      parallel.id === serialMerge.id &&
      parallel.files.length === serial.length &&
      parallel.files.every((file, index) => file.file === serial[index]?.file && file.hash === serial[index]?.hash),
    conflict: {
      blocked: !conflict.ready,
      code: conflict.blockers[0]?.code ?? "",
      subtasks: [guide.id, copy.id].sort(),
      message: conflict.blockers[0]?.message ?? "",
    },
  };
}

/** The parent task both agents work under. */
function demoParent(): TaskDocument {
  const result = registerTask(
    {
      version: 1,
      idempotencyKey: "two-agent-install",
      goal: "Update the install guide and its example in parallel",
      scope: { pages: ["guide/install"], files: ["examples/install.md"] },
      snapshot: { content: "a".repeat(64), data: "b".repeat(64), config: "c".repeat(64), tooling: "d".repeat(64) },
      budget: { contextTokens: 1_000, toolCalls: 20, timeMs: 60_000 },
      permissions: { read: ["agent-parent"], write: ["agent-parent"], check: ["agent-parent"] },
      acceptance: [{ id: "build", statement: "The site builds.", check: "check.build" }],
    },
    { checks: ["check.build"] },
  );
  if (result.task === undefined) throw new Error("the demo parent is invalid");
  return result.task;
}

/** The two owned subtasks. */
function demoSubtasks() {
  return [
    {
      key: "guide",
      owner: "agent-guide",
      goal: "Rewrite the install steps",
      scope: { pages: ["guide/install"], blocks: ["install-steps"] },
      acceptance: [{ id: "guide-build", statement: "The guide builds.", check: "check.build" }],
      budget: { contextTokens: 500, toolCalls: 10, timeMs: 30_000 },
    },
    {
      key: "example",
      owner: "agent-example",
      goal: "Update the install example",
      scope: { files: ["examples/install.md"] },
      acceptance: [{ id: "example-review", statement: "A person reviewed the example.", review: true as const }],
      budget: { contextTokens: 400, toolCalls: 8, timeMs: 20_000 },
    },
  ];
}

/** Two results with fixed hashes and diffs, in dependency order. */
function demoResults(plan: CoordinationPlan): CoordinationSubtaskResult[] {
  const guide = plan.subtasks.find((row) => row.key === "guide")!;
  const example = plan.subtasks.find((row) => row.key === "example")!;
  return [
    {
      subtask: guide.id,
      snapshot: plan.parent.snapshot,
      finishedAt: 100,
      files: [{ file: "guide/install.md", beforeHash: "1".repeat(64), afterHash: "2".repeat(64) }],
      transactions: ["tx-guide"],
      evidence: ["guide.proof.json"],
      diff: "--- a/guide/install.md\n+++ b/guide/install.md\n@@\n-Install\n+Install the tool\n",
    },
    {
      subtask: example.id,
      snapshot: plan.parent.snapshot,
      finishedAt: 200,
      files: [{ file: "examples/install.md", beforeHash: "3".repeat(64), afterHash: "4".repeat(64) }],
      transactions: ["tx-example"],
      evidence: ["example.proof.json"],
      diff: "--- a/examples/install.md\n+++ b/examples/install.md\n@@\n-npx install\n+npx install --check\n",
    },
  ];
}

/** Applies results in plan order and returns the final files, sorted by path. */
function applySequentially(
  plan: CoordinationPlan,
  results: readonly CoordinationSubtaskResult[],
): readonly { readonly file: string; readonly hash: string | null }[] {
  const bySubtask = new Map(results.map((result) => [result.subtask, result] as const));
  const files = new Map<string, string | null>();
  for (const id of plan.order) {
    const result = bySubtask.get(id)!;
    for (const file of [...result.files].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))) {
      if (!files.has(file.file)) files.set(file.file, file.beforeHash);
      if (files.get(file.file) !== file.beforeHash) {
        throw new Error(`the serial run cannot apply ${file.file} in order`);
      }
      files.set(file.file, file.afterHash);
    }
  }
  return [...files].map(([file, hash]) => ({ file, hash })).sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}
