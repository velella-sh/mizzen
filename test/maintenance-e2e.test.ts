/**
 * #1242: an API change follows the whole maintenance path. A real `comparePages` finding becomes a
 * task, an external patch becomes a preview, one verification fails, the next passes, and the
 * proposal becomes a local pull-request recipe with evidence and a last-good state. Nothing here
 * touches the network or merges; the recipe's permissions forbid both.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { MaintenanceCheck, MaintenanceObservations } from "../src/contracts/index.ts";
import { comparePages } from "../src/drift/compare.ts";
import { hashSource } from "../src/edits/patch.ts";
import { sha256 } from "../src/data/lock.ts";
import { buildModel } from "../src/model/build.ts";
import { formatVerificationProof } from "../src/verification/proof.ts";
import { taskSnapshot } from "../src/tasks/snapshot.ts";
import { decideMaintenance, proposeMaintenanceTasks } from "../src/maintenance/propose.ts";
import { previewMaintenance } from "../src/maintenance/preview.ts";
import { verifyMaintenance } from "../src/maintenance/verify.ts";
import { maintenanceRecipe, planMaintenancePullRequest } from "../src/maintenance/recipe.ts";
import {
  maintenanceStateAt,
  maintenanceStateText,
  readMaintenanceState,
  recordMaintenanceFailure,
  retryMaintenance,
  writeMaintenanceState,
} from "../src/maintenance/state.ts";
import { maintenanceChecks } from "./maintenance-fixture.ts";

const FIXTURE = fileURLToPath(new URL("../fixtures/maintenance-api-drift", import.meta.url));
const DOC = join(FIXTURE, "docs/api.md");

/** The span of one ASCII substring in a source, in the engine's 1-based inclusive units. */
function spanOf(source: string, text: string) {
  const offset = source.indexOf(text);
  assert.ok(offset >= 0, `${text} is in ${DOC}`);
  const before = source.slice(0, offset);
  const line = before.split("\n").length;
  const column = Array.from(before.slice(before.lastIndexOf("\n") + 1)).length + 1;
  return { line, column, endLine: line, endColumn: column + text.length - 1 };
}

test("API drift becomes a task, a failed proof, a proved proposal, and one local PR recipe", async () => {
  const markdown = readFileSync(DOC, "utf8");
  const api = readFileSync(join(FIXTURE, "src/api.ts"), "utf8");
  const config = readFileSync(join(FIXTURE, "mizzen.yml"), "utf8");
  assert.match(api, /export function renderPage/);
  assert.match(markdown, /`renderResult`/);

  const { site, diagnostics } = await buildModel(FIXTURE);
  assert.deepEqual(diagnostics.filter((entry) => entry.severity === "error"), []);
  const comparisons = await comparePages(site.pages, { root: FIXTURE });
  const findings = comparisons.flatMap((comparison) =>
    comparison.findings.map((finding) => ({ file: comparison.file, finding })),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.finding.diagnostic.id, "drift.missing-symbol");
  assert.match(findings[0]!.finding.diagnostic.message, /renderResult/);

  const snapshot = taskSnapshot({
    content: sha256(markdown),
    data: sha256(api),
    config: sha256(config),
    tooling: sha256("maintenance-e2e"),
  });
  const observations: MaintenanceObservations = {
    version: 1,
    staleness: [],
    findings: [
      {
        page: findings[0]!.file,
        id: findings[0]!.finding.diagnostic.id,
        message: findings[0]!.finding.diagnostic.message,
        ...(findings[0]!.finding.diagnostic.pos === undefined ? {} : { pos: findings[0]!.finding.diagnostic.pos }),
      },
    ],
    impact: [],
  };

  const decision = decideMaintenance(observations);
  assert.equal(decision.mode, "agent");
  assert.match(decision.reason, /without a mechanical repair/);

  const proposed = proposeMaintenanceTasks(observations, { snapshot });
  assert.deepEqual(proposed.problems, []);
  assert.equal(proposed.tasks.length, 1);
  const task = proposed.tasks[0]!.task;
  assert.deepEqual(task.scope.pages, ["docs/api.md"]);
  assert.match(task.goal, /drift\.missing-symbol/);

  const span = spanOf(markdown, "renderResult");
  const patch = {
    version: 1,
    task: task.id,
    snapshot: task.snapshot.id,
    proposal: "e".repeat(64),
    files: [
      {
        path: "docs/api.md",
        sha256: hashSource(markdown),
        edits: [{ file: "docs/api.md", ...span, expected: "renderResult", replacement: "renderPage" }],
      },
    ],
    claims: [
      {
        criterion: "current",
        statement: "The API page names the exported function.",
        files: ["docs/api.md"],
        checks: ["site"],
      },
    ],
  };

  const preview = previewMaintenance(patch, {
    task,
    sources: { "docs/api.md": markdown },
    outputs: ["/api/"],
  });
  assert.deepEqual(preview.problems, []);
  assert.equal(preview.changed, true);
  assert.match(preview.files[0]!.diff, /renderResult/);
  assert.match(preview.files[0]!.diff, /renderPage/);
  assert.equal(preview.write, "requires-approval");

  const failedChecks: MaintenanceCheck[] = maintenanceChecks({ build: { status: "failed" } });
  const failed = await verifyMaintenance({ task, patch, preview, checks: failedChecks });
  assert.equal(failed.ready, false);
  assert.ok(failed.failures.some((failure) => failure.code === "maintenance.check-missing"));

  const proved = await verifyMaintenance({ task, patch, preview, checks: maintenanceChecks() });
  assert.deepEqual(proved.failures, []);
  assert.equal(proved.ready, true);
  assert.equal(proved.verdict, "proved");
  assert.ok(proved.proof);
  assert.equal(proved.proof.proofHash.length, 64);
  assert.equal(proved.independent?.ok, true);

  const recipe = maintenanceRecipe(task, proved, preview);
  assert.equal(recipe.noop, false);
  assert.deepEqual(recipe.files, ["docs/api.md"]);
  assert.equal(recipe.permissions.merge, false);
  assert.equal(recipe.permissions.publish, false);
  assert.match(recipe.body, /build|renderPage/);

  const created = planMaintenancePullRequest(recipe);
  assert.equal(created.action, "create");
  assert.equal(created.number, undefined);

  const updated = planMaintenancePullRequest(
    maintenanceRecipe(task, { ...proved, snapshot: "f".repeat(64) }, preview),
    [{ number: 12, branch: recipe.branch, labels: ["maintenance", "docs"] }],
  );
  assert.equal(updated.action, "update");
  assert.equal(updated.number, 12);
  assert.deepEqual(updated.labels, ["docs", "maintenance"]);
  assert.equal(new Set(updated.labels).size, updated.labels.length);

  const state = maintenanceStateAt(task, recipe.id, { "docs/api.md": hashSource(markdown) });
  const recorded = recordMaintenanceFailure(state, {
    stage: "verification",
    code: "maintenance.check-missing",
    message: "The build check did not pass on the first attempt.",
  });
  assert.deepEqual(recorded.preserved, state);
  assert.equal(recorded.state.phase, "failed");
  const retried = retryMaintenance(recorded.state, task.snapshot.id);
  assert.equal(retried.resumed, true);
  assert.equal(retried.state.phase, "proposed");

  const root = mkdtempSync(join(tmpdir(), "maintenance-e2e-"));
  try {
    await writeMaintenanceState(root, retried.state);
    const read = await readMaintenanceState(root);
    assert.deepEqual(read.problems, []);
    assert.deepEqual(read.state, retried.state);
    const file = join(root, ".mizzen/maintenance.json");
    assert.equal(readFileSync(file, "utf8"), maintenanceStateText(retried.state));
    const proofFile = join(root, "proof.json");
    writeFileSync(proofFile, formatVerificationProof(proved.proof));
    assert.match(readFileSync(proofFile, "utf8"), new RegExp(proved.proof.proofHash));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
