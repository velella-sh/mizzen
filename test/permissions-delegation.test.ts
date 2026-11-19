import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccessPolicy } from "../src/contracts/permissions.ts";
import { parseAccessPolicy } from "../src/permissions/policy.ts";
import { accessPolicyFingerprint } from "../src/permissions/policy.ts";
import { auditOf, decideAccess, delegatePolicy } from "../src/permissions/evaluate.ts";
import { auditLine } from "../src/permissions/audit.ts";

function policy(value: Record<string, unknown>): AccessPolicy {
  const result = parseAccessPolicy({ version: 1, ...value });
  assert.equal(result.problems.length, 0, JSON.stringify(result.problems));
  assert.ok(result.policy !== undefined);
  return result.policy;
}

const parent = policy({
  capabilities: { read: true, write: true, execute: true, network: true },
  read: { pages: ["docs/**"], collections: ["notes"], fields: { notes: ["title"] } },
  write: { paths: ["docs/**"], scope: { files: ["docs/**"], pages: ["/guide/"] } },
  check: { runners: [{ name: "links", inputs: ["site"], resources: ["pages"] }] },
  network: { destinations: ["https://api.example.com"], stages: ["verify"] },
  approvals: { write: true, execute: true, network: true },
});

const child = policy({
  capabilities: { read: true, write: true },
  read: { pages: ["docs/guide.md"], collections: ["notes"], fields: { notes: ["title"] } },
  write: { paths: ["docs/guide.md"], scope: { files: ["docs/guide.md"], pages: ["/guide/"] } },
  approvals: { write: true },
});

test("a subtask keeps a subset and records its parent", () => {
  const result = delegatePolicy(parent, child);
  assert.deepEqual(result.problems, []);
  assert.ok(result.policy !== undefined);
  assert.equal(result.policy.delegatedFrom, accessPolicyFingerprint(parent));
  assert.equal(result.policy.capabilities.execute, false);
});

test("a subtask cannot widen a capability, read, write, runner, destination, or approval", () => {
  const widened = policy({
    capabilities: { read: true, write: true, execute: true, network: true, publish: true },
    read: { pages: ["private/**"], collections: ["notes"], fields: { notes: ["title"] } },
    write: { paths: ["src/**"], scope: { files: ["src/**"] } },
    check: { runners: [{ name: "shell", inputs: ["*"], resources: ["*"] }] },
    network: { destinations: ["https://evil.example.com"], stages: ["build", "verify"] },
    approvals: { write: false, publish: false },
  });
  const result = delegatePolicy(parent, widened);
  assert.equal(result.policy, undefined);
  const text = JSON.stringify(result.problems);
  for (const fragment of ["/capabilities/publish", "/read", "/write/paths", "/check/runners", "/network/destinations", "/network/stages", "/approvals/write"]) {
    assert.ok(text.includes(fragment), `${fragment} in ${text}`);
  }
  assert.ok(result.problems.every((problem) => problem.code === "access-policy.delegation-widen"));
});

test("the delegated policy and its decisions are auditable", () => {
  const result = delegatePolicy(parent, child);
  assert.ok(result.policy !== undefined);
  const decision = decideAccess(result.policy, {
    capability: "write",
    task: result.policy.task,
    snapshot: "snapshot",
    path: "docs/guide.md",
    scope: { pages: ["/guide/"], blocks: [], collections: [], files: ["docs/guide.md"] },
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.rule, "approval.required");
  const audit = auditOf(result.policy, {
    capability: "write",
    task: result.policy.task,
    snapshot: "snapshot",
    path: "docs/guide.md",
    scope: { pages: ["/guide/"], blocks: [], collections: [], files: ["docs/guide.md"] },
  }, decision);
  assert.equal(audit.policy, accessPolicyFingerprint(result.policy));
  assert.equal(audit.rule, "approval.required");
  assert.equal(audit.approval, null);
  assert.ok(auditLine(audit).includes("approval.required"));
});
