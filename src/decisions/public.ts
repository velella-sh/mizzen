/**
 * The public form of a decision record. The id, title, status, date, links, evidence positions, and span are always
 * published: a reader must be able to see that a decision exists. The source value, the rationale, the context, the
 * decision text, and each alternative's rejection are private by default — an author who wants them published says
 * `public: true` — and a private value is replaced with a fixed placeholder, never shortened, hashed, or quoted, so no
 * part of it reaches a public output.
 *
 * A record whose audience names anything the caller may not read is not public at all: it is left out, so a hidden
 * decision is not distinguishable from a missing one through this layer.
 */
import type {
  DecisionAlternative,
  DecisionPublicAlternative,
  DecisionPublicEntry,
  DecisionRecord,
  DecisionText,
} from "../contracts/decisions.ts";
import { formatSpan } from "../source/spans.ts";

/** The placeholder a private source value is replaced with. */
export const REDACTED_DECISION_SOURCE = "[source withheld]";

/** The placeholder a private rationale, context, or decision text is replaced with. */
export const REDACTED_DECISION_TEXT = "[text withheld]";

/** The placeholder a private alternative's rejection is replaced with. */
export const REDACTED_DECISION_ALTERNATIVE = "[reason withheld]";

/** The public entry of one record: the structural fields, and only the text the author published. */
export function publicDecisionOf(record: DecisionRecord, options: { readonly allow?: readonly string[] } = {}): DecisionPublicEntry {
  const visible = isVisible(record, options.allow);
  const published = visible && record.public;
  const text = (value: DecisionText | undefined): string | undefined => {
    if (value === undefined) return undefined;
    return published ? value.text : REDACTED_DECISION_TEXT;
  };
  const rationale = text(record.rationale);
  const context = text(record.context);
  const decision = text(record.decision);
  return {
    id: record.id,
    title: record.title,
    status: record.status,
    date: record.date,
    source: published || record.source.public === true ? record.source.value : REDACTED_DECISION_SOURCE,
    supersedes: record.supersedes,
    supersededBy: record.supersededBy,
    validity: record.validity,
    links: record.links.map((link) => ({ kind: link.kind, id: link.id, raw: link.raw })),
    evidence: record.evidence.map((entry) => ({ kind: entry.kind, value: published || (entry.kind !== "rfc" && entry.kind !== "pull-request") ? entry.value : REDACTED_DECISION_TEXT, status: entry.status })),
    alternatives: record.alternatives.map((alternative) => publicAlternativeOf(alternative, published)),
    ...(rationale === undefined ? {} : { rationale }),
    ...(context === undefined ? {} : { context }),
    ...(decision === undefined ? {} : { decision }),
    redacted: !published && (record.rationale !== undefined || record.context !== undefined || record.decision !== undefined || record.source.public !== true || record.alternatives.some((alternative) => alternative.rejectedBecause !== undefined)),
    span: formatSpan(record.span),
  };
}

/** Whether the caller may see the record at all: an audience the caller does not hold hides the entire record. */
export function isVisible(record: DecisionRecord, allow: readonly string[] | undefined): boolean {
  if (record.audience.length === 0) return true;
  if (allow === undefined) return false;
  return record.audience.every((audience) => allow.includes(audience));
}

/** One alternative in public form: its name, the position, and its rejection. */
function publicAlternativeOf(alternative: DecisionAlternative, published: boolean): DecisionPublicAlternative {
  return {
    name: alternative.name,
    ...(alternative.rejectedBecause === undefined
      ? {}
      : { rejectedBecause: published ? alternative.rejectedBecause.text : REDACTED_DECISION_ALTERNATIVE }),
    span: formatSpan(alternative.text.span),
  };
}
