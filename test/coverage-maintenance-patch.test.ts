import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccessPolicy } from "../src/contracts/permissions.ts";
import type { MaintenanceObservations } from "../src/contracts/index.ts";
import { hashSource } from "../src/edits/patch.ts";
import {
  applyMaintenancePatch,
  closeNoopTask,
  deterministicMaintenancePatch,
  maintenanceNoop,
  markStalePatch,
  noopEvidenceId,
  parseMaintenancePatch,
  patchMessage,
  staleMaintenancePatch,
} from "../src/maintenance/patch.ts";
import { parseAccessPolicy } from "../src/permissions/policy.ts";
import { transitionTask } from "../src/tasks/lifecycle.ts";
import { registered } from "./tasks-fixture.ts";

const SOURCE = "# API\n\nCall `build(options)`.\n";
const AFTER = SOURCE.replace("build(options)", "build(configs)");
const TASK = registered({
  idempotencyKey: "maintenance-patch-coverage",
  goal: "Update the API guide",
  scope: { pages: [], blocks: [], collections: [], symbols: [], files: ["docs/api.md", "docs/other.md"] },
  acceptance: [
    { id: "doctor", statement: "The doctor passes.", check: "doctor" },
    { id: "review", statement: "A person reviewed it.", review: true },
  ],
});

/** A patch document with one edit, overridable anywhere. */
function patch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

/** The codes parsing `value` reports. */
function codes(value: unknown, options = {}): string[] {
  return parseMaintenancePatch(value, options).problems.map((problem) => problem.code);
}

function policy(value: Record<string, unknown>): AccessPolicy {
  const result = parseAccessPolicy({ version: 1, approvals: { write: false }, ...value });
  assert.deepEqual(result.problems, []);
  assert.ok(result.policy);
  return result.policy;
}

const files = (value: unknown): Record<string, unknown> => ({ ...patch(), files: value });
const edit = (value: unknown): Record<string, unknown> => ({
  ...patch(),
  files: [{ ...(patch().files as Record<string, unknown>[])[0], edits: value }],
});

test("a patch document is refused for every malformed file and edit field", () => {
  const cases: [unknown, string][] = [
    [null, "maintenance.patch"],
    [[], "maintenance.patch"],
    [{ ...patch(), version: 2 }, "maintenance.patch-version"],
    [{ ...patch(), task: "nope" }, "maintenance.patch-task"],
    [{ ...patch(), snapshot: 7 }, "maintenance.patch-snapshot"],
    [{ ...patch(), proposal: "../x" }, "maintenance.patch-proposal"],
    [{ ...patch(), files: [] }, "maintenance.patch-files"],
    [{ ...patch(), files: "docs/api.md" }, "maintenance.patch-files"],
    [files([null]), "maintenance.patch-file"],
    [files([{ ...(patch().files as Record<string, unknown>[])[0], path: "../secret.md" }]), "maintenance.patch-path"],
    [files([{ ...(patch().files as Record<string, unknown>[])[0], sha256: "short" }]), "maintenance.patch-hash"],
    [files([{ ...(patch().files as Record<string, unknown>[])[0], edits: [] }]), "maintenance.patch-edits"],
    [edit([null]), "maintenance.patch-edit"],
    [edit([{ line: 0, column: 1, endLine: 1, endColumn: 1, expected: "x", replacement: "y" }]), "maintenance.patch-span"],
    [edit([{ line: 1, column: 1, endLine: 1, endColumn: 1, expected: 1, replacement: "y" }]), "maintenance.patch-text"],
    [edit([{ line: 1, column: 1, endLine: 1, endColumn: 1, expected: "x" }]), "maintenance.patch-text"],
    [{ ...patch(), claims: undefined }, "maintenance.patch-claims"],
    [{ ...patch(), claims: [null] }, "maintenance.claim"],
    [{ ...patch(), claims: [{ criterion: " ", statement: "x", files: [], checks: [] }] }, "maintenance.claim-criterion"],
    [{ ...patch(), claims: [{ criterion: "doctor", statement: "", files: [], checks: [] }] }, "maintenance.claim-statement"],
    [{ ...patch(), claims: [{ criterion: "doctor", statement: "x", files: ["../x"], checks: [] }] }, "maintenance.claim-files"],
    [{ ...patch(), claims: [{ criterion: "doctor", statement: "x", files: [], checks: [1] }] }, "maintenance.claim-checks"],
  ];
  assert.deepEqual(
    cases.map(([value]) => codes(value)[0]),
    cases.map(([, code]) => code),
  );
});

test("a patch that names another task or an unlisted file is refused", () => {
  assert.ok(codes(patch(), { task: TASK }).length === 0);
  assert.deepEqual(codes(patch({ task: "f".repeat(64) }), { task: TASK }), ["maintenance.patch-task"]);
  assert.deepEqual(codes(patch(), { task: TASK, allowedFiles: ["guides/"] }), ["maintenance.patch-permission"]);
});

test("a policy that denies write, or allows another path, refuses the patch", () => {
  const denied = policy({
    task: "task-one",
    capabilities: { write: false },
    write: { paths: ["docs/**"], scope: { files: ["docs/**"] } },
  });
  assert.deepEqual(codes(patch(), { policy: denied }), ["maintenance.patch-policy"]);

  const elsewhere = policy({
    task: "task-one",
    capabilities: { write: true },
    write: { paths: ["guides/**"], scope: { files: ["guides/**"] } },
  });
  assert.ok(codes(patch(), { policy: elsewhere }).includes("maintenance.patch-write.path"));

  const allowed = policy({
    task: "task-one",
    capabilities: { write: true },
    write: { paths: ["docs/**"], scope: { files: ["docs/**"], pages: ["docs/api.md"] } },
  });
  // Without a task, the file is its own page and file scope.
  assert.deepEqual(codes(patch(), { policy: allowed }), []);
});

test("a missing or changed source stops the in-memory apply and the no-op check", () => {
  const parsed = parseMaintenancePatch(patch(), { task: TASK });
  assert.ok(parsed.patch);
  const missing = applyMaintenancePatch(parsed.patch, {});
  assert.deepEqual(missing.problems.map((problem) => problem.code), ["maintenance.patch-missing"]);
  assert.deepEqual(missing.files, []);

  const stale = applyMaintenancePatch(parsed.patch, { "docs/api.md": `${SOURCE}changed\n` });
  assert.deepEqual(stale.problems.map((problem) => problem.code), ["maintenance.patch-stale"]);
  assert.match(patchMessage(stale), /no longer has the hash/);

  const notNoop = maintenanceNoop(parsed.patch, {});
  assert.deepEqual(notNoop, { noop: false, reason: "none", evidence: [] });

  const ordinary = maintenanceNoop(parsed.patch, { "docs/api.md": SOURCE });
  assert.equal(ordinary.noop, false);
});

test("an unexpected expected text or a duplicate file is an edit error, not a write", () => {
  const wrong = parseMaintenancePatch(
    edit([{ line: 3, column: 7, endLine: 3, endColumn: 20, expected: "wrong text", replacement: "build(configs)" }]),
    { task: TASK },
  );
  assert.ok(wrong.patch);
  const refused = applyMaintenancePatch(wrong.patch, { "docs/api.md": SOURCE });
  assert.equal(refused.problems[0]?.code, "maintenance.patch-expected-mismatch");
  assert.deepEqual(refused.files, []);

  const duplicate = parseMaintenancePatch(files([(patch().files as Record<string, unknown>[])[0], (patch().files as Record<string, unknown>[])[0]]), { task: TASK });
  assert.ok(duplicate.patch);
  const twice = applyMaintenancePatch(duplicate.patch, { "docs/api.md": SOURCE });
  assert.equal(twice.problems[0]?.code, "maintenance.patch-duplicate-file");
});

test("a span outside the source makes a no-op impossible without throwing", () => {
  const parsed = parseMaintenancePatch(
    {
      ...patch(),
      files: [
        {
          path: "docs/api.md",
          sha256: "a".repeat(64),
          edits: [{ line: 99, column: 1, endLine: 99, endColumn: 2, expected: "x", replacement: "y" }],
        },
      ],
    },
    { task: TASK },
  );
  assert.ok(parsed.patch);
  assert.deepEqual(maintenanceNoop(parsed.patch, { "docs/api.md": SOURCE }), {
    noop: false,
    reason: "none",
    evidence: [],
  });
});

test("a missing file is stale, and a task in verify asks for review instead of blocked", () => {
  const parsed = parseMaintenancePatch(patch(), { task: TASK });
  assert.ok(parsed.patch);
  const missing = staleMaintenancePatch(parsed.patch, {}, TASK.snapshot.id);
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.stale, [{ path: "docs/api.md", reason: "missing", before: hashSource(SOURCE), current: null }]);
  assert.match(missing.reason, /docs\/api\.md is missing/);

  const ready = transitionTask(TASK, { to: "ready", reason: "Ready." }).task!;
  const running = transitionTask(ready, { to: "running", reason: "Running." }).task!;
  const verify = transitionTask(running, { to: "verify", reason: "Verifying.", result: "check:doctor" }).task!;
  const review = markStalePatch(verify, missing);
  assert.equal(review.action, "review");
  assert.equal(review.task, undefined);
});

test("a deterministic patch reports missing sources and bad spans", () => {
  const observations = (fixes: MaintenanceObservations["findings"]): MaintenanceObservations => ({
    version: 1,
    staleness: [],
    findings: fixes,
    impact: [],
  });
  const missing = deterministicMaintenancePatch(
    TASK,
    "e".repeat(64),
    observations([{ page: "docs/api.md", id: "missing", message: "Missing.", fix: { file: "docs/api.md", line: 3, column: 7, endLine: 3, endColumn: 20, text: "x", description: "x" } }]),
    {},
  );
  assert.deepEqual(missing.problems.map((problem) => problem.code), ["maintenance.fix-missing"]);

  const badSpan = deterministicMaintenancePatch(
    TASK,
    "e".repeat(64),
    observations([{ page: "docs/api.md", id: "span", message: "Span.", fix: { file: "docs/api.md", line: 99, column: 1, endLine: 99, endColumn: 2, text: "x", description: "x" } }]),
    { "docs/api.md": SOURCE },
  );
  assert.deepEqual(badSpan.problems.map((problem) => problem.code), ["maintenance.fix-span"]);
});

test("a deterministic patch sorts fixes by file and claims every criterion", () => {
  const other = "Other text.\n";
  const observations: MaintenanceObservations = {
    version: 1,
    staleness: [],
    findings: [
      { page: "docs/other.md", id: "other", message: "Other.", fix: { file: "docs/other.md", line: 1, column: 1, endLine: 1, endColumn: 5, text: "Fresh", description: "Fix." } },
      { page: "docs/api.md", id: "api", message: "API.", fix: { file: "docs/api.md", line: 3, column: 7, endLine: 3, endColumn: 20, text: "build(configs)", description: "Fix." } },
    ],
    impact: [],
  };
  const built = deterministicMaintenancePatch(TASK, "e".repeat(64), observations, { "docs/api.md": SOURCE, "docs/other.md": other });
  assert.deepEqual(built.problems, []);
  assert.ok(built.patch);
  assert.deepEqual(built.patch.files.map((file) => file.path), ["docs/api.md", "docs/other.md"]);
  assert.deepEqual(built.patch.claims.map((claim) => claim.criterion), ["doctor", "review"]);
  assert.deepEqual(built.patch.claims[1]?.checks, []);
  const applied = applyMaintenancePatch(built.patch, { "docs/api.md": SOURCE, "docs/other.md": other });
  assert.deepEqual(applied.problems, []);
  assert.match(patchMessage(applied), /^2 of 2 file\(s\) change/);
});

test("a no-op closes a task from every working state and leaves a done task alone", () => {
  const parsed = parseMaintenancePatch(patch(), { task: TASK });
  assert.ok(parsed.patch);
  const noop = maintenanceNoop(parsed.patch, { "docs/api.md": AFTER });
  assert.equal(noop.noop, true);
  assert.match(noopEvidenceId(noop), /^[0-9a-f]{64}$/);

  const ready = transitionTask(TASK, { to: "ready", reason: "Ready." }).task!;
  assert.equal(closeNoopTask(ready, noop).task?.state, "done");
  const running = transitionTask(ready, { to: "running", reason: "Running." }).task!;
  assert.equal(closeNoopTask(running, noop).task?.state, "done");
  const verify = transitionTask(running, { to: "verify", reason: "Verifying.", result: "check:doctor" }).task!;
  assert.equal(closeNoopTask(verify, noop).task?.state, "done");
  const done = transitionTask(verify, { to: "done", reason: "Done.", result: "check:doctor" }).task!;
  assert.equal(closeNoopTask(done, noop).task, done);
  assert.equal(closeNoopTask(TASK, { noop: false, reason: "none", evidence: [] }).task, TASK);
});
