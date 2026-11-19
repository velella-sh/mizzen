import assert from "node:assert/strict";
import { test } from "node:test";
import type { EditTransactionScope } from "../src/contracts/edit-transaction.ts";
import { createLease, leaseIsActive, reclaimLease, releaseLease, renewLease } from "../src/coordination/lease.ts";

const scope: EditTransactionScope = {
  pages: ["guide/install"],
  blocks: ["install-steps"],
  symbols: [],
  records: [],
  files: [],
};

const base = {
  subtask: "subtask-guide",
  owner: "agent-guide",
  scope,
  snapshot: "f".repeat(64),
  nowMs: 1_000,
  ttlMs: 60_000,
};

test("a lease records owner, scope, snapshot, and expiry", () => {
  const first = createLease(base).lease!;
  const again = createLease(base).lease!;
  assert.equal(first.id, again.id);
  assert.equal(first.owner, "agent-guide");
  assert.deepEqual(first.scope, scope);
  assert.equal(first.snapshot, base.snapshot);
  assert.equal(first.expiresAt, 61_000);
  assert.equal(first.generation, 0);
  assert.equal(leaseIsActive(first, 60_999), true);
  assert.equal(leaseIsActive(first, 61_000), false);
});

test("only the owner renews, and an expired lease cannot be renewed", () => {
  const lease = createLease(base).lease!;
  assert.deepEqual(renewLease(lease, { owner: "agent-other", nowMs: 2_000, ttlMs: 60_000 }).problems.map((p) => p.code), [
    "coordination.lease-owner",
  ]);
  const renewed = renewLease(lease, { owner: "agent-guide", nowMs: 2_000, ttlMs: 60_000 }).lease!;
  assert.equal(renewed.id, lease.id);
  assert.equal(renewed.expiresAt, 62_000);
  assert.deepEqual(renewLease(lease, { owner: "agent-guide", nowMs: 61_000, ttlMs: 60_000 }).problems.map((p) => p.code), [
    "coordination.lease-expired",
  ]);
});

test("releasing a lease records a receipt and only the owner may release it", () => {
  const lease = createLease(base).lease!;
  assert.deepEqual(releaseLease(lease, { owner: "agent-other", nowMs: 2_000, reason: "done" }).problems.map((p) => p.code), [
    "coordination.release-owner",
  ]);
  const release = releaseLease(lease, { owner: "agent-guide", nowMs: 2_000, reason: "done" }).release!;
  assert.deepEqual(release, {
    version: 1,
    lease: lease.id,
    subtask: lease.subtask,
    owner: "agent-guide",
    releasedAt: 2_000,
    status: "released",
    reason: "done",
  });
  assert.equal(releaseLease(lease, { owner: "agent-guide", nowMs: 61_000, reason: "late" }).release?.status, "expired");
});

test("an active lease cannot be reclaimed", () => {
  const lease = createLease(base).lease!;
  const result = reclaimLease({
    lease,
    claimant: "agent-next",
    nowMs: 30_000,
    ttlMs: 60_000,
    activity: [],
    state: { snapshot: lease.snapshot, files: {} },
  });
  assert.equal(result.lease, undefined);
  assert.deepEqual(result.problems.map((problem) => problem.code), ["coordination.lease-active"]);
});

test("an active owner's lease is not reclaimed", () => {
  const lease = createLease(base).lease!;
  const result = reclaimLease({
    lease,
    claimant: "agent-next",
    nowMs: 120_000,
    ttlMs: 60_000,
    activity: [{ agent: "agent-guide", at: 118_000, edits: [] }],
    state: { snapshot: lease.snapshot, files: {} },
  });
  assert.deepEqual(result.problems.map((problem) => problem.code), ["coordination.owner-active"]);
});

test("a changed tree refuses reclaim and keeps the owner's edit", () => {
  const lease = createLease(base).lease!;
  const edit = { file: "guide/install.md", beforeHash: "1".repeat(64), afterHash: "2".repeat(64) };
  const result = reclaimLease({
    lease,
    claimant: "agent-next",
    nowMs: 400_000,
    ttlMs: 60_000,
    activity: [{ agent: "agent-guide", at: 2_000, edits: [edit] }],
    state: { snapshot: "9".repeat(64), files: { "guide/install.md": edit.afterHash } },
  });
  assert.deepEqual(result.problems.map((problem) => problem.code), ["coordination.state-changed", "coordination.edits-present"]);
  assert.deepEqual(result.preserved, [edit]);
  assert.equal(result.lease, undefined);
});

test("a quiet owner is replaced only when the tree is unchanged", () => {
  const lease = createLease(base).lease!;
  const result = reclaimLease({
    lease,
    claimant: "agent-next",
    nowMs: 400_000,
    ttlMs: 60_000,
    activity: [{ agent: "agent-guide", at: lease.issuedAt, edits: [] }],
    state: { snapshot: lease.snapshot, files: {} },
  });
  assert.deepEqual(result.problems, []);
  assert.equal(result.lease?.owner, "agent-next");
  assert.equal(result.lease?.generation, 1);
  assert.equal(result.lease?.id === lease.id, false);
  assert.equal(result.reclaim?.from, "agent-guide");
  assert.equal(result.reclaim?.to, "agent-next");
  assert.deepEqual(result.reclaim?.checks.map((check) => [check.id, check.status]), [
    ["expired", "passed"],
    ["owner-quiet", "passed"],
    ["state-unchanged", "passed"],
    ["edits-preserved", "passed"],
  ]);
});

test("malformed lease values are refused with located problems", () => {
  const bad = createLease({ ...base, owner: "*", ttlMs: 0, generation: -1, scope: { pages: [], blocks: [], symbols: [], records: [], files: [] } });
  assert.deepEqual(bad.problems.map((problem) => problem.code), [
    "coordination.lease-value",
    "coordination.lease-scope",
    "coordination.lease-duration",
    "coordination.lease-generation",
  ]);
  assert.equal(createLease({ ...base, nowMs: -1 }).problems[0]?.code, "coordination.lease-time");
});
