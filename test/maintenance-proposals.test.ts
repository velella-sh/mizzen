import assert from "node:assert/strict";
import { test } from "node:test";
import type { MaintenanceObservations } from "../src/contracts/index.ts";
import { defaultAccessPolicy } from "../src/permissions/policy.ts";
import { taskSnapshot } from "../src/tasks/snapshot.ts";
import {
  constrainMaintenanceScope,
  decideMaintenance,
  deterministicFixes,
  proposeMaintenanceTasks,
} from "../src/maintenance/propose.ts";

const snapshot = taskSnapshot({
  content: "a".repeat(64),
  data: "b".repeat(64),
  config: "c".repeat(64),
  tooling: "d".repeat(64),
});

function observations(overrides: Partial<MaintenanceObservations> = {}): MaintenanceObservations {
  return {
    version: 1,
    staleness: [],
    findings: [],
    impact: [],
    ...overrides,
  };
}

test("staleness, drift findings, and data impact become tasks with goal, scope, and acceptance", () => {
  const drift = observations({
    staleness: [{ page: "docs/guide.md", files: [{ path: "src/api.ts", change: "changed" }] }],
    findings: [
      {
        page: "docs/api.md",
        id: "drift.missing-symbol",
        message: "The page names `build`.",
        pos: { file: "docs/api.md", line: 4, column: 1, endLine: 4, endColumn: 9 },
      },
    ],
    impact: [
      { collection: "catalog", record: "one", pages: ["docs/catalog.md"], outputs: ["/api/catalog/"] },
    ],
  });

  const result = proposeMaintenanceTasks(drift, { snapshot });
  assert.deepEqual(result.problems, []);
  assert.equal(result.tasks.length, 3);
  assert.deepEqual(
    result.tasks.map((entry) => entry.task.scope.pages).flat().sort(),
    ["docs/api.md", "docs/catalog.md", "docs/guide.md"],
  );
  const stale = result.tasks.find((entry) => entry.trigger === "stale:docs/guide.md")!;
  assert.match(stale.task.goal, /docs\/guide\.md/);
  assert.deepEqual(stale.task.scope.files, ["src/api.ts"]);
  assert.equal(stale.task.acceptance[0]!.check, "site");
  const impact = result.tasks.find((entry) => entry.trigger === "impact:catalog:one")!;
  assert.match(impact.task.goal, /catalog\/one/);
  assert.deepEqual(impact.task.scope.collections, ["catalog"]);
});

test("a no-impact record and a page with no finding create no task, with a reason", () => {
  const result = proposeMaintenanceTasks(
    observations({
      impact: [{ collection: "catalog", record: "two", pages: ["docs/catalog.md"], outputs: [] }],
      staleness: [{ page: "docs/clean.md", files: [] }],
    }),
    { snapshot },
  );
  assert.deepEqual(result.tasks, []);
  assert.deepEqual(
    result.skipped.map((entry) => [entry.kind, entry.reason]),
    [
      ["impact", "the record has no published output, so it has no documentation impact"],
    ],
  );
});

test("a mechanical diagnostic is deterministic and semantic drift needs an agent", () => {
  const deterministic = observations({
    findings: [
      {
        page: "docs/api.md",
        id: "drift.line-out-of-range",
        message: "The line moved.",
        fix: { file: "docs/api.md", line: 2, column: 3, endLine: 2, endColumn: 5, text: "24", description: "Update the line." },
      },
    ],
  });
  const decision = decideMaintenance(deterministic);
  assert.equal(decision.mode, "deterministic");
  assert.match(decision.reason, /safe mechanical repair/);
  assert.deepEqual(decision.fixes, ["drift.line-out-of-range"]);
  assert.deepEqual(decision.semantic, []);
  assert.equal(deterministicFixes(deterministic).length, 1);

  const semantic = decideMaintenance(
    observations({ findings: [{ page: "docs/api.md", id: "drift.missing-symbol", message: "Missing." }] }),
  );
  assert.equal(semantic.mode, "agent");
  assert.match(semantic.reason, /without a mechanical repair/);
  assert.deepEqual(semantic.fixes, []);
  assert.deepEqual(semantic.semantic, ["drift.missing-symbol"]);

  assert.equal(decideMaintenance(observations()).mode, "none");
});

test("scope keeps only drifted pages and files, and site permissions exclude the rest", () => {
  const result = proposeMaintenanceTasks(
    observations({
      findings: [
        {
          page: "docs/api.md",
          id: "drift.missing-symbol",
          message: "Missing.",
          pos: { file: "src/api.ts", line: 1, column: 1, endLine: 1, endColumn: 1 },
        },
      ],
    }),
    { snapshot, allowedFiles: ["docs/api.md"], allowedPages: ["docs/api.md"] },
  );
  assert.deepEqual(result.problems, []);
  assert.equal(result.tasks.length, 1);
  assert.deepEqual(result.tasks[0]!.task.scope, {
    pages: ["docs/api.md"],
    blocks: [],
    collections: [],
    symbols: [],
    files: [],
  });

  const excluded = constrainMaintenanceScope(
    { pages: ["docs/api.md", "docs/other.md"], blocks: [], collections: [], symbols: [], files: ["src/api.ts"] },
    { allowedPages: ["docs/api.md"], allowedFiles: ["docs/api.md"] },
  );
  assert.deepEqual(excluded.scope.pages, ["docs/api.md"]);
  assert.deepEqual(excluded.scope.files, []);
  assert.deepEqual(
    excluded.excluded.map((entry) => entry.ref).sort(),
    ["docs/other.md", "src/api.ts"],
  );
});

test("a site policy that denies a write excludes the file and names the rule", () => {
  const policy = {
    ...defaultAccessPolicy("site"),
    capabilities: { ...defaultAccessPolicy().capabilities, write: true },
    write: {
      paths: ["docs/**"],
      scope: { pages: ["docs/**"], blocks: [], collections: [], files: ["docs/**"] },
    },
  };
  const result = constrainMaintenanceScope(
    { pages: ["docs/api.md"], blocks: [], collections: [], symbols: [], files: ["src/api.ts"] },
    { policy },
  );
  assert.deepEqual(result.scope.files, []);
  assert.equal(result.excluded[0]!.reason, "write.path");
});
