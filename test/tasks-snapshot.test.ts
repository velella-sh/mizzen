import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTaskContract } from "../src/tasks/contract.ts";
import { registerTask } from "../src/tasks/register.ts";
import { snapshotChanged, snapshotIdOf, taskSnapshot } from "../src/tasks/snapshot.ts";
import { contractInput, registered } from "./tasks-fixture.ts";

const hashes = {
  content: "a".repeat(64),
  data: "b".repeat(64),
  config: "c".repeat(64),
  tooling: "d".repeat(64),
};

test("a snapshot hashes content, data, config, and tooling into one stable id", () => {
  const first = taskSnapshot(hashes);
  const second = taskSnapshot({ ...hashes });

  assert.match(first.id, /^[0-9a-f]{64}$/);
  assert.equal(second.id, first.id);
  assert.equal(first.id, snapshotIdOf(hashes));
  assert.deepEqual(Object.keys(first), ["content", "data", "config", "tooling", "id"]);
});

test("changing any material input produces a new snapshot", () => {
  const before = taskSnapshot(hashes);
  for (const field of ["content", "data", "config", "tooling"] as const) {
    const after = taskSnapshot({ ...hashes, [field]: "e".repeat(64) });
    assert.notEqual(after.id, before.id, `${field} must change the snapshot id`);
    assert.equal(snapshotChanged(before, after), true);
  }
  assert.equal(snapshotChanged(before, hashes), false);
});

test("a supplied snapshot id must match the four hashes", () => {
  const id = snapshotIdOf(hashes);
  const ok = parseTaskContract(contractInput({ snapshot: { ...hashes, id } }));
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.contract?.snapshot.id, id);

  const refused = parseTaskContract(
    contractInput({ snapshot: { ...hashes, id: "f".repeat(64) } }),
  );
  assert.equal(refused.contract, undefined);
  const [problem] = refused.problems;
  assert.ok(problem);
  assert.equal(problem.path, "/snapshot/id");
  assert.equal(problem.code, "task.snapshot-id");
  assert.match(problem.message, new RegExp(id));
});

test("a changed input cannot be registered as the same task", () => {
  const task = registered();
  const changed = registerTask(
    contractInput({ snapshot: { ...hashes, content: "e".repeat(64) } }),
    { checks: ["doctor", "test"], existing: [task] },
  );

  assert.equal(changed.task, undefined);
  assert.equal(changed.problems[0]?.code, "task.idempotency-conflict");
});
