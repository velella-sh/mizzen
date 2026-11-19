import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  maintenanceBranch,
  maintenanceRecipe,
  planMaintenancePullRequest,
} from "../src/maintenance/recipe.ts";
import {
  maintenanceFailureReport,
  maintenanceStateAt,
  maintenanceStateText,
  readMaintenanceState,
  recordMaintenanceFailure,
  retryMaintenance,
  writeMaintenanceState,
} from "../src/maintenance/state.ts";
import { HASH, maintenanceTask, verifiedMaintenance } from "./maintenance-fixture.ts";

test("a proved proposal becomes one recipe with diff, evidence, impact, and no merge", async () => {
  const { task, preview, verification } = await verifiedMaintenance();
  assert.equal(verification.ready, true);
  const recipe = maintenanceRecipe(task, verification, preview);

  assert.equal(recipe.noop, false);
  assert.equal(recipe.branch, maintenanceBranch(task.id));
  assert.match(recipe.title, /^\[maintenance\] /);
  assert.deepEqual(recipe.files, ["docs/api.md"]);
  assert.deepEqual(recipe.labels, ["maintenance"]);
  assert.deepEqual(recipe.outputs, ["/api/catalog/"]);
  assert.equal(recipe.permissions.merge, false);
  assert.equal(recipe.permissions.publish, false);
  assert.match(recipe.body, /<!-- mizzen-maintenance -->/);
  assert.match(recipe.body, /```diff/);
  assert.match(recipe.body, /build\(configs\)/);
  assert.match(recipe.body, /`page`: proved/);
  assert.match(recipe.body, /\/api\/catalog\//);
  assert.match(recipe.body, /no publish or merge permission/);
});

test("a later proposal for the same task updates the open pull request without a duplicate", async () => {
  const { task, preview, verification } = await verifiedMaintenance();
  const first = maintenanceRecipe(task, verification, preview);
  const create = planMaintenancePullRequest(first);
  assert.equal(create.action, "create");
  assert.equal(create.number, undefined);

  const later = maintenanceRecipe(task, { ...verification, snapshot: HASH("f") }, preview);
  assert.equal(later.branch, first.branch, "the branch follows the task, not the snapshot");
  const update = planMaintenancePullRequest(later, [
    { number: 7, branch: first.branch, labels: ["docs", "maintenance"] },
  ]);
  assert.equal(update.action, "update");
  assert.equal(update.number, 7);
  assert.deepEqual(update.labels, ["docs", "maintenance"]);
  assert.equal(new Set(update.labels).size, update.labels.length);
});

test("a proposal that is not ready or changes nothing opens no pull request", async () => {
  const { task, preview, verification } = await verifiedMaintenance();
  const recipe = maintenanceRecipe(task, { ...verification, ready: false }, preview);
  assert.equal(recipe.noop, true);
  assert.equal(planMaintenancePullRequest(recipe).action, "none");
});

test("a failure preserves the last good snapshot and sources, and retry is explicit", async () => {
  const task = maintenanceTask();
  const state = maintenanceStateAt(task, "e".repeat(64), { "docs/api.md": HASH("a") });
  const { state: failed, preserved } = recordMaintenanceFailure(state, {
    stage: "verification",
    code: "maintenance.check-missing",
    message: "The build check did not pass.",
  });

  assert.equal(failed.phase, "failed");
  assert.equal(failed.snapshot, state.snapshot);
  assert.deepEqual(failed.sources, state.sources);
  assert.equal(failed.proposal, state.proposal);
  assert.deepEqual(preserved, state);
  assert.equal(failed.failures.length, 1);
  assert.doesNotMatch(maintenanceFailureReport(failed), /build\(options\)/);

  const blocked = retryMaintenance(state);
  assert.equal(blocked.resumed, false);
  const retried = retryMaintenance(failed, HASH("f"));
  assert.equal(retried.resumed, true);
  assert.equal(retried.state.phase, "proposed");
  assert.equal(retried.state.snapshot, HASH("f"));
  assert.equal(retried.state.failures.length, 1, "the failure history is kept");
});

test("the state file is canonical and reads back unchanged", async () => {
  const task = maintenanceTask();
  const state = maintenanceStateAt(task, "e".repeat(64), { "z.md": HASH("b"), "a.md": HASH("a") });
  const root = mkdtempSync(join(tmpdir(), "maintenance-state-"));
  try {
    await writeMaintenanceState(root, state);
    const text = readFileSync(join(root, ".mizzen/maintenance.json"), "utf8");
    assert.equal(text, maintenanceStateText(state));
    assert.ok(text.endsWith("\n"));
    assert.ok(text.indexOf('"a.md"') < text.indexOf('"z.md"'));
    const read = await readMaintenanceState(root);
    assert.deepEqual(read.problems, []);
    assert.deepEqual(read.state, state);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
