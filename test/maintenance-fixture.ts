import assert from "node:assert/strict";
import type {
  MaintenanceCheck,
  MaintenanceClaim,
  MaintenanceCheckKind,
  MaintenancePatch,
  MaintenancePreview,
  TaskDocument,
} from "../src/contracts/index.ts";
import { hashSource } from "../src/edits/patch.ts";
import { previewMaintenance } from "../src/maintenance/preview.ts";
import { verifyMaintenance } from "../src/maintenance/verify.ts";
import { registerTask } from "../src/tasks/register.ts";
import { contractInput } from "./tasks-fixture.ts";

/** The API guide the fixture changes. */
export const SOURCE = "# API\n\nCall `build(options)`.\n";
export const AFTER = SOURCE.replace("build(options)", "build(configs)");
export const HASH = (letter: string): string => letter.repeat(64);

/** A task that owns the API guide. */
export function maintenanceTask(
  acceptance: readonly Record<string, unknown>[] = [{ id: "page", statement: "The guide is current.", check: "site" }],
  key = "maintenance-fixture",
): TaskDocument {
  const result = registerTask(
    contractInput({
      idempotencyKey: key,
      goal: "Update the API guide",
      scope: { pages: [], blocks: [], collections: [], symbols: [], files: ["docs/api.md"] },
      acceptance,
    }),
    { checks: ["site"] },
  );
  assert.deepEqual(result.problems, []);
  return result.task!;
}

/** A valid external patch for the guide. */
export function maintenancePatch(
  task: TaskDocument,
  claims: readonly MaintenanceClaim[] = [
    { criterion: "page", statement: "The guide is current.", files: ["docs/api.md"], checks: ["site"] },
  ],
): MaintenancePatch {
  return {
    version: 1,
    task: task.id,
    snapshot: task.snapshot.id,
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
    claims: [...claims],
  };
}

/** A preview of the fixture patch. */
export function maintenancePreview(task: TaskDocument, patch: MaintenancePatch): MaintenancePreview {
  return previewMaintenance(patch, { task, sources: { "docs/api.md": SOURCE }, outputs: ["/api/catalog/"] });
}

/** The five passed checks a complete proposal needs. */
export function maintenanceChecks(
  overrides: Partial<Record<MaintenanceCheckKind, Partial<MaintenanceCheck>>> = {},
): MaintenanceCheck[] {
  return (["schema", "links", "examples", "build", "task"] as const).map((kind, index) => ({
    id: kind === "task" ? "site" : kind,
    kind,
    status: "passed" as const,
    outputHash: HASH(String(index)),
    ...(kind === "task" ? { criterion: "page" } : {}),
    ...overrides[kind],
  }));
}

/** A proved, independently verified proposal. */
export async function verifiedMaintenance(): Promise<{
  readonly task: TaskDocument;
  readonly patch: MaintenancePatch;
  readonly preview: MaintenancePreview;
  readonly verification: Awaited<ReturnType<typeof verifyMaintenance>>;
}> {
  const task = maintenanceTask();
  const patch = maintenancePatch(task);
  const preview = maintenancePreview(task, patch);
  const verification = await verifyMaintenance({ task, patch, preview, checks: maintenanceChecks() });
  return { task, patch, preview, verification };
}
