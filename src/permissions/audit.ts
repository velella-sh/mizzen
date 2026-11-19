/**
 * The access audit line: one JSON object per allow or deny decision, with the task, capability, rule, approval, and
 * snapshot. It never carries content, a secret, a denied label, or a machine-local path; a resource is a stable id
 * (a URL, a runner name, an origin, or a site-relative path) and free text is redacted again on the way out.
 */
import type { AccessAuditRecord } from "../contracts/permissions.ts";
import { redactAccessText } from "./redact.ts";

/** One audit line, with its free text redacted and its keys in one fixed order. */
export function auditLine(record: AccessAuditRecord): string {
  return `${JSON.stringify({
    version: record.version,
    task: redactAccessText(record.task),
    capability: record.capability,
    decision: record.decision,
    rule: record.rule,
    reason: redactAccessText(record.reason),
    approval: record.approval,
    snapshot: record.snapshot,
    policy: record.policy,
    ...(record.resource === undefined ? {} : { resource: redactAccessText(record.resource) }),
  })}\n`;
}

/** A newline-delimited audit ledger as text, in the order given. */
export function auditLedger(records: readonly AccessAuditRecord[]): string {
  return records.map(auditLine).join("");
}
