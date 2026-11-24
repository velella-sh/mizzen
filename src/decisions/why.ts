/**
 * Answers "why does this behavior or page exist": the decision in effect at a version or snapshot, its rationale and
 * rejected alternatives, and the decisions that came before, each with a citation.
 *
 * The subject is matched against each record's links, by a stable id: `page:guide/caching.md`, `behavior:cache-hit`,
 * `collection:users`, `api:…`, or `surface:…`. A bare subject is also matched by a page's URL or source path, because
 * that is what a reader has in hand. The match is exact on the stable id; nothing is inferred from prose.
 *
 * Only a record the caller may read is considered, and a private value is replaced before it reaches the answer, so
 * a citation can never be a way around the policy.
 */
import type {
  DecisionLink,
  DecisionQuery,
  DecisionRecord,
  DecisionWhy,
  DecisionWhyEntry,
} from "../contracts/decisions.ts";
import { formatSpan } from "../source/spans.ts";
import { cycleIdSet, inEffectAt, type LifecycleResult } from "./lifecycle.ts";
import { isVisible } from "./public.ts";
import { REDACTED_DECISION_ALTERNATIVE, REDACTED_DECISION_SOURCE, REDACTED_DECISION_TEXT } from "./public.ts";

/** Options of {@link why}. */
export interface WhyOptions {
  /** The lifecycle result, so cycle members are known. */
  readonly lifecycle: LifecycleResult;
  /** The version and snapshot the question is about; absent asks about the current state. */
  readonly query?: DecisionQuery;
  /** Audiences the caller may read; without it, a record with an audience is not considered. */
  readonly allow?: readonly string[];
}

/** The link kinds a bare subject may match, in the order a tie is broken. */
const SUBJECT_KINDS: readonly DecisionLink["kind"][] = ["page", "behavior", "collection", "api", "surface"];

/**
 * Whether a record's links name the subject. A subject written with a kind prefix matches only that kind and id; a
 * bare subject matches a page's URL or source path, and then any kind whose id equals it.
 */
function mentions(record: DecisionRecord, subject: string): boolean {
  const value = subject.trim();
  if (value === "") return false;
  const at = value.indexOf(":");
  if (at > 0 && (SUBJECT_KINDS as readonly string[]).includes(value.slice(0, at))) {
    const kind = value.slice(0, at);
    const id = value.slice(at + 1);
    return record.links.some((link) => link.kind === kind && (link.id === id || link.id === `/${id.replace(/^\/+|\/+$/g, "")}/` || link.id.replace(/^\/+|\/+$/g, "") === id.replace(/^\/+|\/+$/g, "")));
  }
  const cleaned = stripPath(value);
  return record.links.some((link) => {
    if (link.kind === "page") return stripPath(link.id) === cleaned || stripPath(link.raw) === cleaned;
    return link.id === value || `${link.kind}:${link.id}` === value;
  });
}

/** A URL or source path without its scheme, base, leading slash, or trailing slash. */
function stripPath(value: string): string {
  return value
    .replace(/^[a-z][a-z\d+.-]*:\/\/[^/]+/i, "")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/index\.md$/i, "")
    .replace(/\.md$/i, "");
}

/** One record in the answer, in public form. */
function whyEntryOf(record: DecisionRecord, published: boolean, current: boolean, allow: readonly string[] | undefined): DecisionWhyEntry {
  const visible = isVisible(record, allow);
  const text = (value: { readonly text: string } | undefined): string | undefined => {
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
    ...(rationale === undefined ? {} : { rationale }),
    ...(context === undefined ? {} : { context }),
    ...(decision === undefined ? {} : { decision }),
    alternatives: record.alternatives.map((alternative) => ({
      name: alternative.name,
      ...(alternative.rejectedBecause === undefined
        ? {}
        : { rejectedBecause: published ? alternative.rejectedBecause.text : REDACTED_DECISION_ALTERNATIVE }),
      span: formatSpan(alternative.text.span),
    })),
    links: record.links.map((link) => ({ kind: link.kind, id: link.id, raw: link.raw })),
    evidence: record.evidence.map((entry) => ({ kind: entry.kind, value: published || (entry.kind !== "rfc" && entry.kind !== "pull-request") ? entry.value : REDACTED_DECISION_TEXT, status: entry.status })),
    validity: record.validity,
    supersedes: record.supersedes,
    supersededBy: record.supersededBy,
    current,
    redacted: !visible,
    span: formatSpan(record.span),
  };
}

/**
 * Answers the question. The current decision is the record in effect at the query among those that name the subject;
 * the history is every other applicable record that names it, newest first. The answer is `answerable` when a current
 * decision exists.
 */
export function why(subject: string, records: readonly DecisionRecord[], options: WhyOptions): DecisionWhy {
  const query = options.query ?? {};
  const allow = options.allow;
  const visible = records.filter((record) => isVisible(record, allow));
  // A subject matches a link, but a record with no links can still be the answer when the caller names its id.
  const byId = visible.find((record) => record.id === subject.trim());
  const candidates = byId === undefined ? visible.filter((record) => mentions(record, subject)) : [byId];

  // The history names what the current decision supersedes, so the candidates reach every record they name even when
  // that record never mentions the subject. Any such record is still subject to the same audience and cycle rules.
  const candidateIds = new Set(candidates.map((record) => record.id));
  const reachable = [...candidates];
  for (const record of candidates) {
    for (const target of record.supersedes) {
      if (candidateIds.has(target)) continue;
      const other = visible.find((entry) => entry.id === target);
      if (other === undefined) continue;
      candidateIds.add(target);
      reachable.push(other);
    }
  }

  const resolution = inEffectAt(reachable, query, cycleIdSet(options.lifecycle));
  const published = (record: DecisionRecord): boolean => record.public && isVisible(record, allow);
  const current = resolution.current;
  const history = resolution.history.map((record) => whyEntryOf(record, published(record), false, allow));
  return {
    version: 1,
    subject: subject.trim(),
    query,
    ...(current === undefined ? {} : { current: whyEntryOf(current, published(current), true, allow) }),
    history,
    answerable: current !== undefined,
  };
}
