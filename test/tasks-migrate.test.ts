import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { migrateTaskDocument, migrateTaskFile } from "../src/tasks/migrate.ts";
import { contractInput } from "./tasks-fixture.ts";

/** A version-0 document with the old budget field names. */
function v0(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 0,
    idempotencyKey: "legacy-1",
    goal: "Update the install guide",
    scope: { pages: ["/guide/install/"] },
    snapshot: {
      content: "a".repeat(64),
      data: "b".repeat(64),
      config: "c".repeat(64),
      tooling: "d".repeat(64),
    },
    budget: { maxTokens: 6000, maxToolCalls: 20, maxMilliseconds: 60000 },
    ...extra,
  };
}

/** A temporary folder, removed by the caller. */
function scratch(): string {
  return mkdtempSync(join(tmpdir(), "tasks-migrate-"));
}

test("version 0 is migrated through an explicit version 1 contract", () => {
  const result = migrateTaskDocument(v0());
  assert.deepEqual(result.problems, []);
  assert.ok(result.contract);
  assert.equal(result.contract.version, 1);
  assert.equal(result.contract.idempotencyKey, "legacy-1");
  assert.deepEqual(result.contract.budget, { contextTokens: 6000, toolCalls: 20, timeMs: 60000 });
  assert.deepEqual(result.contract.permissions, { read: ["*"], write: [], check: [] });
  assert.deepEqual(result.contract.acceptance, [
    {
      id: "human-review",
      statement: "A person reviewed the migrated task because version 0 recorded no acceptance criteria.",
      review: true,
    },
  ]);
});

test("a missing version-0 key is derived deterministically from the content", () => {
  const withoutKey = v0();
  delete withoutKey.idempotencyKey;
  const first = migrateTaskDocument(withoutKey).contract;
  const second = migrateTaskDocument(withoutKey).contract;

  assert.ok(first);
  assert.match(first.idempotencyKey, /^legacy-[0-9a-f]{16}$/);
  assert.equal(second?.idempotencyKey, first.idempotencyKey);
  assert.equal(JSON.stringify(second), JSON.stringify(first));
});

test("version 1 is read as-is", () => {
  const result = migrateTaskDocument(contractInput(), { checks: ["doctor", "test"] });
  assert.deepEqual(result.problems, []);
  assert.equal(result.contract?.version, 1);
  assert.equal(result.contract?.goal, "Update the install guide");
});

test("an unknown version is refused at /version", () => {
  const result = migrateTaskDocument({ ...v0(), version: 2 });
  assert.equal(result.contract, undefined);
  assert.deepEqual(result.problems.map((problem) => [problem.path, problem.code]), [
    ["/version", "task.version"],
  ]);
});

test("a broken version-0 document is refused without a partial contract", () => {
  const result = migrateTaskDocument(v0({ budget: { maxTokens: 6000 } }));
  assert.equal(result.contract, undefined);
  assert.ok(result.problems.length > 0);
});

test("a successful file migration writes the target and leaves the source alone", async () => {
  const folder = scratch();
  try {
    const source = join(folder, "task.json");
    const target = join(folder, "migrated.json");
    writeFileSync(source, `${JSON.stringify(v0(), null, 2)}\n`);

    const result = await migrateTaskFile(source, { target });
    assert.deepEqual(result.problems, []);
    assert.equal(result.written, target);
    assert.ok(result.contract);

    assert.deepEqual(JSON.parse(readFileSync(source, "utf8")), v0());
    const written = JSON.parse(readFileSync(target, "utf8")) as { version: number; budget: unknown };
    assert.equal(written.version, 1);
    assert.deepEqual(written.budget, { contextTokens: 6000, toolCalls: 20, timeMs: 60000 });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("a failed migration leaves the source byte-identical and writes no target", async () => {
  const folder = scratch();
  try {
    const source = join(folder, "task.json");
    const target = join(folder, "migrated.json");
    const broken = { ...v0(), version: 7 };
    writeFileSync(source, `${JSON.stringify(broken, null, 2)}\n`);
    const before = readFileSync(source);

    const result = await migrateTaskFile(source, { target });
    assert.equal(result.contract, undefined);
    assert.equal(result.written, undefined);
    assert.ok(result.problems.length > 0);
    assert.deepEqual(readFileSync(source), before);
    assert.equal(existsSync(target), false);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("a failed in-place migration leaves the source byte-identical", async () => {
  const folder = scratch();
  try {
    const source = join(folder, "task.json");
    writeFileSync(source, `${JSON.stringify(v0({ budget: {} }))}\n`);
    const before = readFileSync(source);

    const result = await migrateTaskFile(source);
    assert.equal(result.contract, undefined);
    assert.deepEqual(readFileSync(source), before);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("a file that is not JSON is refused without writing", async () => {
  const folder = scratch();
  try {
    const source = join(folder, "task.json");
    writeFileSync(source, "not json\n");
    const result = await migrateTaskFile(source);
    assert.equal(result.problems[0]?.code, "task.json");
    assert.equal(readFileSync(source, "utf8"), "not json\n");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
