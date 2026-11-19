import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccessGrant } from "../src/contracts/index.ts";
import { hashSource } from "../src/edits/patch.ts";
import { accessPolicyFingerprint, defaultAccessPolicy } from "../src/permissions/policy.ts";
import { previewMaintenance } from "../src/maintenance/preview.ts";
import { registerTask } from "../src/tasks/register.ts";
import { contractInput } from "./tasks-fixture.ts";

const SOURCE = "# API\n\nCall `build(options)`.\n";
const REGISTRATION = registerTask(
  contractInput({
    idempotencyKey: "maintenance-preview",
    scope: { pages: [], blocks: [], collections: [], symbols: [], files: ["docs/api.md"] },
    acceptance: [
      { id: "page", statement: "The guide is current.", check: "site" },
      { id: "schema", statement: "The schema check passes.", check: "schema" },
    ],
  }),
  { checks: ["site", "schema"] },
);
assert.deepEqual(REGISTRATION.problems, []);
const TASK = REGISTRATION.task!;

function patch(replacement = "build(configs)"): unknown {
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
            replacement,
          },
        ],
      },
    ],
    claims: [{ criterion: "page", statement: "The guide is current.", files: ["docs/api.md"], checks: ["site"] }],
  };
}

function policy(write: boolean, approval: boolean) {
  return {
    ...defaultAccessPolicy("site"),
    capabilities: { ...defaultAccessPolicy().capabilities, write },
    write: { paths: ["docs/**"], scope: { pages: [], blocks: [], collections: [], files: ["docs/**"] } },
    approvals: { ...defaultAccessPolicy().approvals, write: approval },
  };
}

test("a preview shows the diff, required checks, and affected outputs without changing source", () => {
  const preview = previewMaintenance(patch(), {
    task: TASK,
    sources: { "docs/api.md": SOURCE },
    outputs: ["/api/catalog/"],
  });
  assert.equal(preview.version, 1);
  assert.equal(preview.changed, true);
  assert.equal(preview.files[0]!.path, "docs/api.md");
  assert.match(preview.files[0]!.diff, /build\(options\)/);
  assert.deepEqual(
    preview.checks.map((check) => [check.id, check.kind, check.status]),
    [["site", "task", "planned"], ["schema", "schema", "planned"]],
  );
  assert.deepEqual(preview.outputs, ["/api/catalog/"]);
  assert.equal(preview.write, "requires-approval");
  assert.match(preview.writeReason, /person must approve/);
  assert.equal(SOURCE, "# API\n\nCall `build(options)`.\n");
});

test("a policy can allow the write, deny it, or still require the approval it declares", () => {
  const sources = { "docs/api.md": SOURCE };
  const denied = previewMaintenance(patch(), { task: TASK, sources, policy: policy(false, false) });
  assert.equal(denied.write, "denied");
  assert.match(denied.writeReason, /denies write/);

  const allowed = previewMaintenance(patch(), { task: TASK, sources, policy: policy(true, false) });
  assert.equal(allowed.write, "allowed");

  const needsApproval = previewMaintenance(patch(), { task: TASK, sources, policy: policy(true, true) });
  assert.equal(needsApproval.write, "requires-approval");

  const access = policy(true, true);
  const grant: AccessGrant = {
    id: "approval-1",
    capability: "write",
    principal: "maintainer",
    decision: "approved",
    reason: "Reviewed the diff.",
    snapshot: TASK.snapshot.id,
    policy: accessPolicyFingerprint(access),
    files: ["docs/api.md"],
  };
  assert.equal(previewMaintenance(patch(), { task: TASK, sources, policy: access, approval: grant }).write, "allowed");
});

test("an invalid patch or a no-op is denied and changes no file", () => {
  const invalid = previewMaintenance(
    { ...patch(), snapshot: "f".repeat(64) },
    { task: TASK, sources: { "docs/api.md": SOURCE } },
  );
  assert.equal(invalid.changed, false);
  assert.deepEqual(invalid.files, []);
  assert.equal(invalid.write, "denied");
  assert.ok(invalid.problems.some((problem) => problem.code === "maintenance.patch-snapshot"));

  const noop = previewMaintenance(patch("build(options)"), { task: TASK, sources: { "docs/api.md": SOURCE } });
  assert.equal(noop.changed, false);
  assert.equal(noop.write, "dry-run");
});
