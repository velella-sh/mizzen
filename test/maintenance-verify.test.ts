import assert from "node:assert/strict";
import { test } from "node:test";
import type { MaintenanceCheck, MaintenanceCheckKind, MaintenancePatch } from "../src/contracts/index.ts";
import { hashSource } from "../src/edits/patch.ts";
import { previewMaintenance } from "../src/maintenance/preview.ts";
import { verifyMaintenance } from "../src/maintenance/verify.ts";
import { registerTask } from "../src/tasks/register.ts";
import { contractInput } from "./tasks-fixture.ts";

const SOURCE = "# API\n\nCall `build(options)`.\n";
const HASH = (letter: string): string => letter.repeat(64);

function task(acceptance: readonly Record<string, unknown>[] = [{ id: "page", statement: "The guide is current.", check: "site" }]) {
  const result = registerTask(
    contractInput({
      idempotencyKey: "maintenance-verify",
      scope: { pages: [], blocks: [], collections: [], symbols: [], files: ["docs/api.md"] },
      acceptance,
    }),
    { checks: ["site"] },
  );
  assert.deepEqual(result.problems, []);
  return result.task!;
}

function patch(claims: readonly Record<string, unknown>[] = [
  { criterion: "page", statement: "The guide is current.", files: ["docs/api.md"], checks: ["site"] },
]) {
  return {
    version: 1,
    task: task().id,
    snapshot: task().snapshot.id,
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
    claims,
  };
}

function checks(overrides: Partial<Record<MaintenanceCheckKind, Partial<MaintenanceCheck>>> = {}): MaintenanceCheck[] {
  return (["schema", "links", "examples", "build", "task"] as const).map((kind, index) => ({
    id: kind === "task" ? "site" : kind,
    kind,
    status: "passed" as const,
    outputHash: HASH(String(index)),
    ...(kind === "task" ? { criterion: "page" } : {}),
    ...overrides[kind],
  }));
}

async function verified(
  acceptance?: readonly Record<string, unknown>[],
  patchClaims?: readonly Record<string, unknown>[],
  checkResults?: MaintenanceCheck[],
  humanReview?: { status: "approved" | "rejected" | "pending"; criteria: readonly string[] },
) {
  const document = task(acceptance);
  const raw = { ...patch(patchClaims), task: document.id, snapshot: document.snapshot.id } as unknown as MaintenancePatch;
  const preview = previewMaintenance(raw, { task: document, sources: { "docs/api.md": SOURCE } });
  return verifyMaintenance({
    task: document,
    patch: raw,
    preview,
    checks: checkResults ?? checks(),
    ...(humanReview === undefined ? {} : { humanReview }),
  });
}

test("a complete proposal is proved and independently verified", async () => {
  const result = await verified();
  assert.deepEqual(result.failures, []);
  assert.equal(result.verdict, "proved");
  assert.equal(result.ready, true);
  assert.equal(result.claims.length, 1);
  assert.equal(result.claims[0]!.status, "proved");
  assert.ok(result.proof);
  assert.equal(result.proof.proofHash.length, 64);
  assert.equal(result.independent?.ok, true);
  assert.equal(result.independent?.proofHash, "matched");
  assert.equal(result.scope.ok, true);
});

test("a claim that cites an unchanged file or an unrun check is rejected", async () => {
  const result = await verified(
    undefined,
    [{ criterion: "page", statement: "The guide is current.", files: ["docs/other.md"], checks: ["not-run"] }],
  );
  assert.equal(result.ready, false);
  assert.ok(result.failures.some((failure) => failure.code === "maintenance.claim-file"));
  assert.ok(result.failures.some((failure) => failure.code === "maintenance.claim-check"));
});

test("a failed or missing required check withholds proof", async () => {
  const failed = await verified(undefined, undefined, checks({ build: { status: "failed" } }));
  assert.equal(failed.ready, false);
  assert.ok(failed.failures.some((failure) => failure.code === "maintenance.check-missing"));

  const missing = await verified(undefined, undefined, checks().filter((check) => check.kind !== "examples"));
  assert.equal(missing.ready, false);
  assert.ok(missing.failures.some((failure) => failure.code === "maintenance.check-missing"));
});

test("a review criterion is proved only by an approved review", async () => {
  const pending = await verified([{ id: "review", statement: "A person read the page.", review: true }], [
    { criterion: "review", statement: "A person read the page.", files: ["docs/api.md"], checks: [] },
  ]);
  assert.equal(pending.ready, false);
  assert.equal(pending.verdict, "incomplete");

  const approved = await verified(
    [{ id: "review", statement: "A person read the page.", review: true }],
    [{ criterion: "review", statement: "A person read the page.", files: ["docs/api.md"], checks: [] }],
    checks(),
    { status: "approved", criteria: ["review"] },
  );
  assert.equal(approved.ready, true);
  assert.equal(approved.claims[0]!.status, "proved");
});
