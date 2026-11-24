/**
 * The access policy for decision memory: which records a caller may see, and the same policy applied to the citation
 * each record carries.
 *
 * A record is readable when its audience is allowed by the caller and the read policy allows the page the record's
 * source names. The citation a record publishes is checked by the same policy, so a decision that is visible does not
 * become a way to read a page or a collection the policy refuses: an unauthorized citation is replaced with the
 * withheld placeholder, never shortened or quoted.
 *
 * The functions here never read disk or a clock, and a denial names no title, id, or value the caller may not see.
 */
import type { AccessPolicy } from "../contracts/permissions.ts";
import type { DecisionRecord } from "../contracts/decisions.ts";
import { readRule } from "../permissions/evaluate.ts";
import { isVisible } from "./public.ts";
import { REDACTED_DECISION_SOURCE } from "./public.ts";

/** Whether a record's audience lets the caller see it, given the audiences the caller may read. */
export function audienceAllows(record: DecisionRecord, allow: readonly string[] | undefined): boolean {
  return isVisible(record, allow);
}

/**
 * Whether the caller may read the page a record lives on. A record is named by its own id and lives in a file; the
 * resource is the record's source page, so the read policy's page allowlist covers it. A record with no policy, or a
 * policy that allows every page, is readable.
 */
export function recordReadable(record: DecisionRecord, access: AccessPolicy | undefined): boolean {
  if (access === undefined) return true;
  const page = record.span.file.replace(/\\/g, "/");
  return readRule(access, { kind: "page", id: page, page }).allowed;
}

/** Whether the caller may follow the record's citation: the source value is the resource, checked by the same policy. */
export function citationReadable(record: DecisionRecord, access: AccessPolicy | undefined): boolean {
  if (access === undefined) return true;
  const value = record.source.value;
  const kind = /^https?:/i.test(value) ? "page" : "other";
  return readRule(access, { kind, id: value }).allowed;
}

/**
 * Whether a record may be published at all: its audience allows the caller, the read policy allows its page, and its
 * citation is readable under the same policy. A record kept back for any reason is left out, so it is not
 * distinguishable from a missing one.
 */
export function decisionReadable(record: DecisionRecord, allow: readonly string[] | undefined, access: AccessPolicy | undefined): boolean {
  return audienceAllows(record, allow) && recordReadable(record, access) && citationReadable(record, access);
}

/** The citation a public output shows: the value when the caller may follow it, else the withheld placeholder. */
export function publishedCitation(record: DecisionRecord, access: AccessPolicy | undefined, published: boolean): string {
  if (!published || record.source.public !== true) return REDACTED_DECISION_SOURCE;
  return citationReadable(record, access) ? record.source.value : REDACTED_DECISION_SOURCE;
}
