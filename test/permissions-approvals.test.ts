import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccessGrant, AccessPolicy } from "../src/contracts/permissions.ts";
import { accessPolicyFingerprint, parseAccessPolicy } from "../src/permissions/policy.ts";
import { approvalValid, decideAccess } from "../src/permissions/evaluate.ts";

function policy(value: Record<string, unknown>): AccessPolicy {
  const result = parseAccessPolicy({ version: 1, ...value });
  assert.equal(result.problems.length, 0, JSON.stringify(result.problems));
  assert.ok(result.policy !== undefined);
  return result.policy;
}

const request = { task: "task", snapshot: "snapshot" } as const;

function grant(policyValue: AccessPolicy, value: Partial<AccessGrant>): AccessGrant {
  return {
    id: "grant-1",
    capability: "write",
    principal: "person",
    decision: "approved",
    reason: "reviewed",
    snapshot: "snapshot",
    policy: accessPolicyFingerprint(policyValue),
    ...value,
  };
}

const runnerPolicy = policy({
  capabilities: { execute: true },
  check: { runners: [{ name: "links", inputs: ["site"], resources: ["pages"] }] },
  approvals: { execute: false },
});

test("a check runner is selected by name, inputs, and resources", () => {
  const ok = decideAccess(runnerPolicy, {
    ...request,
    capability: "execute",
    runner: "links",
    inputs: ["site"],
    resources: ["pages"],
  });
  assert.equal(ok.allowed, true);
  assert.equal(ok.rule, "execute.allowed");

  const unknown = decideAccess(runnerPolicy, { ...request, capability: "execute", runner: "shell" });
  assert.equal(unknown.allowed, false);
  assert.equal(unknown.rule, "execute.runner");

  const extraInput = decideAccess(runnerPolicy, { ...request, capability: "execute", runner: "links", inputs: ["site", "--force"] });
  assert.equal(extraInput.allowed, false);
  assert.equal(extraInput.rule, "execute.inputs");

  const extraResource = decideAccess(runnerPolicy, { ...request, capability: "execute", runner: "links", resources: ["secrets"] });
  assert.equal(extraResource.allowed, false);
  assert.equal(extraResource.rule, "execute.resources");

  const network = decideAccess(runnerPolicy, { ...request, capability: "network", destination: "https://api.example.com", stage: "verify" });
  assert.equal(network.allowed, false);
  assert.equal(network.rule, "capability.network");
});

const approvedPolicy = policy({
  capabilities: { read: true, write: true, publish: true },
  write: { paths: ["docs/**"], scope: { files: ["docs/**"] } },
  approvals: { read: true, write: true, execute: true, publish: true },
});

const writeRequest = {
  ...request,
  capability: "write" as const,
  path: "docs/guide.md",
  scope: { pages: [], blocks: [], collections: [], files: ["docs/guide.md"] },
};

test("one capability's approval never covers another", () => {
  const readGrant = grant(approvedPolicy, { id: "read-1", capability: "read" });
  const write = decideAccess(approvedPolicy, { ...writeRequest, approvals: [readGrant] });
  assert.equal(write.allowed, false);
  assert.equal(write.rule, "approval.required");

  const writeGrant = grant(approvedPolicy, { id: "write-1", files: ["docs/**"] });
  const allowed = decideAccess(approvedPolicy, { ...writeRequest, approvals: [writeGrant] });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.approval, "write-1");

  const publish = decideAccess(approvedPolicy, { ...request, capability: "publish", approvals: [writeGrant] });
  assert.equal(publish.allowed, false);
  assert.equal(publish.rule, "approval.required");
});

test("an old snapshot or policy makes an approval stale", () => {
  const valid = grant(approvedPolicy, { files: ["docs/**"] });
  assert.equal(decideAccess(approvedPolicy, { ...writeRequest, approvals: [valid] }).allowed, true);
  assert.equal(approvalValid(valid, approvedPolicy, "snapshot"), true);
  assert.equal(approvalValid(valid, approvedPolicy, "changed"), false);

  const oldSnapshot = decideAccess(approvedPolicy, { ...writeRequest, approvals: [{ ...valid, snapshot: "old" }] });
  assert.equal(oldSnapshot.allowed, false);
  assert.equal(oldSnapshot.rule, "approval.stale");

  const changedPolicy = policy({
    capabilities: { read: true, write: true, publish: true },
    read: { pages: ["docs/guide.md"] },
    write: { paths: ["docs/**"], scope: { files: ["docs/**"] } },
    approvals: { read: true, write: true, execute: true, publish: true },
  });
  assert.notEqual(accessPolicyFingerprint(changedPolicy), accessPolicyFingerprint(approvedPolicy));
  const oldPolicy = decideAccess(changedPolicy, { ...writeRequest, approvals: [valid] });
  assert.equal(oldPolicy.allowed, false);
  assert.equal(oldPolicy.rule, "approval.stale");
});

test("a rejected approval is never treated as a grant", () => {
  const rejected = grant(approvedPolicy, { files: ["docs/**"], decision: "rejected", id: "no-1" });
  const decision = decideAccess(approvedPolicy, { ...writeRequest, approvals: [rejected] });
  assert.equal(decision.allowed, false);
  assert.equal(decision.rule, "approval.rejected");
});

test("an approval with the wrong files does not cover the write", () => {
  const elsewhere = grant(approvedPolicy, { files: ["other/**"] });
  const decision = decideAccess(approvedPolicy, { ...writeRequest, approvals: [elsewhere] });
  assert.equal(decision.allowed, false);
  assert.equal(decision.rule, "approval.scope");
});
