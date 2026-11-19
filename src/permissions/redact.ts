/**
 * One redaction policy for every output a task can reach: packs, diffs, traces, proofs, errors, artifacts, and audit
 * lines.
 *
 * The replacement is fixed (`<redacted>` for a value, `<path>` for a machine-local path), so a placeholder never
 * carries a length, a prefix, a hash, or any other shape of the value it replaced. Content that a policy denies is
 * omitted before this function runs; this is the second layer, for free text that may echo a credential or a local
 * path by accident.
 */
import { redactAuditText } from "../edits/audit.ts";
import type { AccessPolicy, AccessResource } from "../contracts/permissions.ts";
import { anyReferenceMatches } from "./match.ts";

/** The one placeholder a redacted value becomes. */
export const ACCESS_REDACTED = "<redacted>";

/** Free text with credentials, tokens, and machine-local paths replaced. Deterministic and idempotent. */
export function redactAccessText(text: string): string {
  return redactAuditText(text);
}

/** True when a read resource's field is public under the policy. */
export function fieldIsReadable(policy: AccessPolicy, resource: AccessResource): boolean {
  if (resource.collection === undefined || resource.field === undefined) return true;
  if (policy.read.collections !== undefined && !anyReferenceMatches(policy.read.collections, resource.collection)) return false;
  const fields = policy.read.fields?.[resource.collection];
  return fields === undefined || anyReferenceMatches(fields, resource.field);
}

/**
 * Fields as a redacted output may carry them: a field the policy denies is replaced by {@link ACCESS_REDACTED}, never
 * by its value or a hint about it. This is for a caller that must keep a key to say "there was a field"; an output
 * that can simply omit it should use `src/data/public.ts` instead.
 */
export function redactFields(
  policy: AccessPolicy,
  collection: string,
  fields: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(fields)) {
    const readable = fieldIsReadable(policy, { kind: "field", id: field, collection, field });
    out[field] = readable ? value : ACCESS_REDACTED;
  }
  return out;
}

/** The placeholder for one denied read; the same text for every resource, so it reveals nothing by shape. */
export function omissionPlaceholder(): string {
  return ACCESS_REDACTED;
}
