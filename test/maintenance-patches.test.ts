import assert from "node:assert/strict";
import { test } from "node:test";
import type { MaintenanceObservations, MaintenancePatch } from "../src/contracts/index.ts";
import { hashSource } from "../src/edits/patch.ts";
import { transitionTask } from "../src/tasks/lifecycle.ts";
import {
  applyMaintenancePatch,
  closeNoopTask,
  deterministicMaintenancePatch,
  maintenanceNoop,
  markStalePatch,
  parseMaintenancePatch,
  staleMaintenancePatch,
} from "../src/maintenance/patch.ts";
import { registered } from "./tasks-fixture.ts";

const SOURCE = "# API\n\nCall `build(options)`.\n";
const AFTER = SOURCE.replace("build(options)", "build(configs)");
const TASK = registered({
  idempotencyKey: "maintenance-patch",
  goal: "Update the API guide",
  scope: { pages: [], blocks: [], collections: [], symbols: [], files: ["docs/api.md"] },
});

function patch(overrides: Partial<MaintenancePatch> = {}): unknown {
  return {
    version: 1,
    task: TASK.id,
    snapshot: TASK.snapshot.id,
    proposal: "e".repeat(64),
    files: [
      {
        path: "docs/api.md",
        sha256: hashSource(SOURCE),
        edits: [
          {
            file: "docs/api.md",
            line: 3,
            column: 7,
            endLine: 3,
            endColumn: 20,
            expected: "build(options)",
            replacement: "build(configs)",
          },
        ],
      },
    ],
    claims: [{ criterion: "doctor", statement: "The guide is current.", files: ["docs/api.md"], checks: ["doctor"] }],
    ...overrides,
  };
}

test("an external patch is validated against the task and applies only in memory", () => {
  const parsed = parseMaintenancePatch(patch(), { task: TASK, allowedFiles: ["docs/api.md"] });
  assert.deepEqual(parsed.problems, []);
  assert.ok(parsed.patch);
  const applied = applyMaintenancePatch(parsed.patch, { "docs/api.md": SOURCE });
  assert.deepEqual(applied.problems, []);
  assert.equal(applied.files[0]!.after, AFTER);
  assert.match(applied.files[0]!.diff, /-.*build\(options\)/);
  assert.match(applied.files[0]!.diff, /\+.*build\(configs\)/);
  assert.equal(SOURCE, "# API\n\nCall `build(options)`.\n", "the source string is never changed");
});

test("a patch outside the task scope, another snapshot, or an unknown criterion is refused", () => {
  const outside = parseMaintenancePatch(
    patch({
      files: [
        {
          path: "docs/other.md",
          sha256: hashSource(SOURCE),
          edits: [
            {
              file: "docs/other.md",
              line: 1,
              column: 1,
              endLine: 1,
              endColumn: 2,
              expected: "# ",
              replacement: "# ",
            },
          ],
        },
      ],
    }),
    { task: TASK },
  );
  assert.ok(outside.problems.some((problem) => problem.code === "maintenance.patch-scope"));
  const empty = parseMaintenancePatch(patch({ files: [{ path: "docs/api.md", sha256: hashSource(SOURCE), edits: [] }] }), { task: TASK });
  assert.ok(empty.problems.some((problem) => problem.code === "maintenance.patch-edits"));

  const snapshot = parseMaintenancePatch(patch({ snapshot: "f".repeat(64) }), { task: TASK });
  assert.ok(snapshot.problems.some((problem) => problem.code === "maintenance.patch-snapshot"));

  const claim = parseMaintenancePatch(
    patch({ claims: [{ criterion: "nope", statement: "Unknown.", files: ["docs/api.md"], checks: [] }] }),
    { task: TASK },
  );
  assert.ok(claim.problems.some((problem) => problem.code === "maintenance.claim-unknown"));
});

test("a changed source stops the stale patch and marks the task blocked", () => {
  const parsed = parseMaintenancePatch(patch(), { task: TASK });
  assert.ok(parsed.patch);
  const stale = staleMaintenancePatch(parsed.patch, { "docs/api.md": `${SOURCE}changed\n` }, TASK.snapshot.id);
  assert.equal(stale.ok, false);
  assert.equal(stale.action, "rebase");
  assert.equal(stale.stale[0]!.reason, "changed");
  assert.match(stale.reason, /rebase/);

  const ready = transitionTask(TASK, { to: "ready", reason: "Ready." }).task!;
  const marked = markStalePatch(ready, stale);
  assert.equal(marked.task?.state, "blocked");
  assert.match(marked.task!.events.at(-1)!.reason, /Rebase/);

  const snapshot = staleMaintenancePatch(parsed.patch, { "docs/api.md": SOURCE }, "a".repeat(64));
  assert.equal(snapshot.stale[0]!.reason, "snapshot");
});

test("an empty diff and a change a human already made are no-ops", () => {
  const parsed = parseMaintenancePatch(
    patch({
      files: [
        {
          path: "docs/api.md",
          sha256: hashSource(SOURCE),
          edits: [
            {
              file: "docs/api.md",
              line: 3,
              column: 7,
              endLine: 3,
              endColumn: 20,
              expected: "build(options)",
              replacement: "build(options)",
            },
          ],
        },
      ],
    }),
    { task: TASK },
  );
  assert.ok(parsed.patch);
  assert.deepEqual(maintenanceNoop(parsed.patch, { "docs/api.md": SOURCE }), {
    noop: true,
    reason: "empty-diff",
    evidence: ["docs/api.md: no bytes differ"],
  });

  const ordinary = parseMaintenancePatch(patch(), { task: TASK });
  assert.ok(ordinary.patch);
  const already = maintenanceNoop(ordinary.patch, { "docs/api.md": AFTER });
  assert.equal(already.noop, true);
  assert.equal(already.reason, "already-resolved");

  const closed = closeNoopTask(TASK, already);
  assert.deepEqual(closed.problems, []);
  assert.equal(closed.task?.state, "done");
  assert.match(closed.task!.events.at(-1)!.result ?? "", /^noop:/);
});

test("a mechanical diagnostic fix becomes a patch without a model", () => {
  const observations: MaintenanceObservations = {
    version: 1,
    staleness: [],
    findings: [
      {
        page: "docs/api.md",
        id: "drift.line-out-of-range",
        message: "The line moved.",
        fix: { file: "docs/api.md", line: 3, column: 7, endLine: 3, endColumn: 20, text: "build(configs)", description: "Update the call." },
      },
    ],
    impact: [],
  };
  const built = deterministicMaintenancePatch(TASK, "e".repeat(64), observations, { "docs/api.md": SOURCE });
  assert.deepEqual(built.problems, []);
  assert.ok(built.patch);
  assert.equal(built.patch.files[0]!.edits[0]!.expected, "build(options)");
  assert.equal(built.patch.files[0]!.edits[0]!.replacement, "build(configs)");
  assert.equal(built.patch.claims[0]!.criterion, "doctor");
  const applied = applyMaintenancePatch(built.patch, { "docs/api.md": SOURCE });
  assert.equal(applied.files[0]!.after, AFTER);
});
