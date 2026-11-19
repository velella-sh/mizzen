import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccessPolicy } from "../src/contracts/permissions.ts";
import {
  accessPolicyFingerprint,
  defaultAccessPolicy,
  parseAccessPolicy,
  writeScopeWithin,
} from "../src/permissions/index.ts";
import { decideAccess } from "../src/permissions/evaluate.ts";

function parsed(value: unknown): AccessPolicy {
  const result = parseAccessPolicy(value);
  assert.equal(result.problems.length, 0, JSON.stringify(result.problems));
  assert.ok(result.policy !== undefined);
  return result.policy;
}

const request = { task: "task-a", snapshot: "snapshot-a" } as const;

test("a minimal policy fills least-privilege defaults", () => {
  const policy = parsed({ version: 1 });
  assert.deepEqual(policy.capabilities, {
    read: true,
    write: false,
    execute: false,
    network: false,
    publish: false,
  });
  assert.equal(policy.read.public, true);
  assert.deepEqual(policy.write.paths, []);
  assert.deepEqual(policy.check.runners, []);
  assert.deepEqual(policy.network.destinations, []);
  assert.equal(policy.approvals.write, true);
});

test("no policy grants public read only", () => {
  const policy = defaultAccessPolicy();
  assert.equal(decideAccess(policy, { ...request, capability: "read", resource: { kind: "page", id: "guide.md" } }).allowed, true);
  for (const capability of ["write", "execute", "network", "publish"] as const) {
    const decision = decideAccess(policy, { ...request, capability });
    assert.equal(decision.allowed, false);
    assert.equal(decision.rule, `capability.${capability}`);
  }
});

test("a malformed policy reports the JSON Pointer of each problem", () => {
  const missing = parseAccessPolicy({ version: 1, capabilities: { write: true } });
  assert.ok(missing.problems.some((problem) => problem.path === "/capabilities/write" && problem.code === "access-policy.write-unscoped"));
  const unknown = parseAccessPolicy({ version: 1, surprise: true });
  assert.ok(unknown.problems.some((problem) => problem.path === "/surprise"));
  const empty = parseAccessPolicy({ version: 1, capabilities: { execute: true } });
  assert.ok(empty.problems.some((problem) => problem.path === "/capabilities/execute"));
});

test("empty arrays deny rather than allow everything", () => {
  const policy = parsed({
    version: 1,
    read: { collections: [], pages: [] },
  });
  assert.equal(decideAccess(policy, { ...request, capability: "read", resource: { kind: "page", id: "guide.md" } }).allowed, false);
  assert.equal(
    decideAccess(policy, { ...request, capability: "read", resource: { kind: "collection", id: "notes", collection: "notes" } }).allowed,
    false,
  );
});

test("field allowlists are per collection and deny a field left out", () => {
  const policy = parsed({
    version: 1,
    read: { collections: ["notes"], fields: { notes: ["title"] } },
  });
  assert.equal(decideAccess(policy, { ...request, capability: "read", resource: { kind: "field", id: "title", collection: "notes", field: "title" } }).allowed, true);
  assert.equal(decideAccess(policy, { ...request, capability: "read", resource: { kind: "field", id: "secret", collection: "notes", field: "secret" } }).allowed, false);
});

test("a write needs the path and a semantic scope that names the same page", () => {
  const policy = parsed({
    version: 1,
    capabilities: { write: true },
    write: { paths: ["docs/**"], scope: { pages: ["/guide/"] } },
    approvals: { write: false },
  });
  const scope = { pages: ["/guide/"], blocks: [], collections: [], files: ["docs/guide.md"] };
  assert.equal(decideAccess(policy, { ...request, capability: "write", path: "docs/guide.md", scope }).allowed, true);
  assert.equal(decideAccess(policy, { ...request, capability: "write", path: "docs/guide.md", scope: { ...scope, pages: ["/private/"] } }).allowed, false);
  assert.equal(decideAccess(policy, { ...request, capability: "write", path: "other/guide.md", scope }).allowed, false);
  assert.equal(writeScopeWithin(policy.write.scope, scope, "docs/guide.md"), true);
});

test("the same policy always has the same fingerprint", () => {
  const a = parsed({ version: 1, read: { audiences: ["staff"] } });
  const b = parsed({ version: 1, read: { audiences: ["staff"] } });
  assert.equal(accessPolicyFingerprint(a), accessPolicyFingerprint(b));
  const c = parsed({ version: 1, read: { audiences: ["public"] } });
  assert.notEqual(accessPolicyFingerprint(a), accessPolicyFingerprint(c));
});
