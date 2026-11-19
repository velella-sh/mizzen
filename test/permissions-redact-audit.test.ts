import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccessPolicy } from "../src/contracts/permissions.ts";
import { parseAccessPolicy } from "../src/permissions/policy.ts";
import { ACCESS_REDACTED, omissionPlaceholder, redactAccessText, redactFields } from "../src/permissions/redact.ts";
import { decideAccess, auditOf } from "../src/permissions/evaluate.ts";
import { auditLine } from "../src/permissions/audit.ts";

function policy(value: Record<string, unknown>): AccessPolicy {
  const result = parseAccessPolicy({ version: 1, ...value });
  assert.equal(result.problems.length, 0, JSON.stringify(result.problems));
  assert.ok(result.policy !== undefined);
  return result.policy;
}

test("redaction removes credentials and machine paths without revealing their shape", () => {
  const text = redactAccessText("token=supersecret value api_key: abc123 at /Users/armin/private/site");
  assert.equal(text.includes("supersecret"), false);
  assert.equal(text.includes("abc123"), false);
  assert.equal(text.includes("/Users/armin"), false);
  assert.ok(text.includes(ACCESS_REDACTED) || text.includes("<path>"));
  assert.equal(redactAccessText(text), text);
  assert.equal(omissionPlaceholder(), ACCESS_REDACTED);
});

test("a denied field is replaced by one placeholder, not its value", () => {
  const access = policy({ read: { collections: ["notes"], fields: { notes: ["title"] } } });
  const redacted = redactFields(access, "notes", { title: "Public note", statement: "internal secret" });
  assert.equal(redacted.title, "Public note");
  assert.equal(redacted.statement, ACCESS_REDACTED);
  assert.equal(JSON.stringify(redacted).includes("internal secret"), false);
});

test("an audit line has task, capability, rule, and approval but no denied content or secret", () => {
  const access = policy({ read: { audiences: ["staff"] } });
  const request = {
    capability: "read" as const,
    task: "task",
    snapshot: "snapshot",
    resource: { kind: "page" as const, id: "page:internal", audiences: ["other"] },
  };
  const decision = decideAccess(access, request);
  assert.equal(decision.allowed, false);
  const line = auditLine(auditOf(access, request, decision));
  const record = JSON.parse(line) as Record<string, unknown>;
  assert.equal(record.task, "task");
  assert.equal(record.capability, "read");
  assert.equal(record.decision, "deny");
  assert.equal(record.rule, "read.audiences");
  assert.equal(record.approval, null);
  assert.equal(record.reason, decision.reason);
  assert.equal(line.includes("internal secret"), false);
  assert.equal(line.includes("staff"), false);
});
