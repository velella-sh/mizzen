import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccessGrant, AccessPolicy } from "../src/contracts/permissions.ts";
import { accessPolicyFingerprint, defaultAccessPolicy, parseAccessPolicy } from "../src/permissions/policy.ts";
import { gatedFetch, networkDecision } from "../src/permissions/network.ts";

function policy(value: Record<string, unknown>): AccessPolicy {
  const result = parseAccessPolicy({ version: 1, ...value });
  assert.equal(result.problems.length, 0, JSON.stringify(result.problems));
  assert.ok(result.policy !== undefined);
  return result.policy;
}

const gate = (access: AccessPolicy, stage: "build" | "verify" | "replay" | "publish" = "verify", approvals?: readonly AccessGrant[]) => ({
  policy: access,
  task: "task",
  snapshot: "snapshot",
  stage,
  ...(approvals === undefined ? {} : { approvals }),
});

test("network is denied by default", () => {
  const decision = networkDecision(gate(defaultAccessPolicy()), "https://api.example.com/v1");
  assert.equal(decision.allowed, false);
  assert.equal(decision.rule, "capability.network");
});

test("a destination and stage must both be allowed", () => {
  const access = policy({
    capabilities: { network: true },
    network: { destinations: ["https://api.example.com"], stages: ["verify"] },
    approvals: { network: false },
  });
  assert.equal(networkDecision(gate(access), "https://api.example.com/v1").allowed, true);
  assert.equal(networkDecision(gate(access, "build"), "https://api.example.com/v1").allowed, false);
  assert.equal(networkDecision(gate(access), "https://evil.example.com/v1").allowed, false);
  assert.equal(networkDecision(gate(access), "https://api.example.com.evil.test/v1").allowed, false);
});

test("an approval names the destination and stage, and a stale one is refused", () => {
  const access = policy({
    capabilities: { network: true },
    network: { destinations: ["https://api.example.com"], stages: ["verify"] },
  });
  const approved: AccessGrant = {
    id: "network-1",
    capability: "network",
    principal: "person",
    decision: "approved",
    reason: "fetch the API",
    snapshot: "snapshot",
    policy: accessPolicyFingerprint(access),
    destination: "https://api.example.com",
    stage: "verify",
  };
  assert.equal(networkDecision(gate(access, "verify", [approved]), "https://api.example.com/v1").allowed, true);
  assert.equal(networkDecision(gate(access, "verify", [{ ...approved, stage: "build" }]), "https://api.example.com/v1").allowed, false);
  assert.equal(networkDecision(gate(access, "verify", [{ ...approved, snapshot: "old" }]), "https://api.example.com/v1").allowed, false);
  assert.equal(networkDecision(gate(access, "verify", [{ ...approved, destination: "https://other.example.com" }]), "https://api.example.com/v1").allowed, false);
});

test("a denied fetch never calls the underlying fetcher", async () => {
  let calls = 0;
  const fetcher = gatedFetch(gate(defaultAccessPolicy()), async () => {
    calls += 1;
    return new Response("ok");
  });
  await assert.rejects(fetcher("https://api.example.com"), /Network access denied/);
  assert.equal(calls, 0);

  const allowed = policy({
    capabilities: { network: true },
    network: { destinations: ["https://api.example.com"], stages: ["verify"] },
    approvals: { network: false },
  });
  const response = await gatedFetch(gate(allowed), async () => {
    calls += 1;
    return new Response("ok");
  })("https://api.example.com/v1");
  assert.equal(await response.text(), "ok");
  assert.equal(calls, 1);
});
