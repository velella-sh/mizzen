/**
 * Builds the versioned decision report: every record in public form, the counts by status, the evidence a build could
 * not resolve, and the lifecycle problems.
 *
 * The report is deterministic: records are sorted by id, evidence by kind and value, and no clock, network, or
 * environment is read. A private source, rationale, or alternative rejection is replaced with its placeholder before it
 * reaches the report, so nothing here can publish a value the author kept private.
 */
import type {
  DecisionCounts,
  DecisionProblem,
  DecisionPublicEntry,
  DecisionRecord,
  DecisionReport,
} from "../contracts/decisions.ts";
import { byCodePoint, sortPublicEntries } from "./order.ts";
import { publicDecisionOf } from "./public.ts";

/** The zero counts, as a mutable accumulator the report fills and then returns as a frozen value. */
function emptyCounts(): { -readonly [K in keyof DecisionCounts]: number } {
  return { proposed: 0, accepted: 0, superseded: 0, deprecated: 0, rejected: 0 };
}

/** What a report needs beyond the records. */
export interface DecisionReportOptions {
  /** The documentation build identity, when the report comes from a build. */
  readonly build?: string;
  /** Audiences the caller may read; without it, a record with an audience is left out. */
  readonly allow?: readonly string[];
  /** Lifecycle problems found while reading the records, reported beside the entries. */
  readonly problems?: readonly DecisionProblem[];
}

/** One record's unresolved evidence, flattened for the report. */
export function unresolvedEvidenceOf(records: readonly DecisionRecord[]): { readonly decision: string; readonly value: string; readonly kind: DecisionRecord["evidence"][number]["kind"] }[] {
  const out: { decision: string; value: string; kind: DecisionRecord["evidence"][number]["kind"] }[] = [];
  for (const record of records) {
    for (const entry of record.evidence) {
      if (entry.status === "unknown") out.push({ decision: record.id, value: entry.value, kind: entry.kind });
    }
  }
  return out.sort((a, b) => byCodePoint(a.decision, b.decision) || byCodePoint(a.kind, b.kind) || byCodePoint(a.value, b.value));
}

/**
 * Builds the report. Every record is listed in public form; a record whose audience the caller may not read is left out
 * entirely, so its id never appears. The counts name each status, including zero, so a reader never confuses an absent
 * status with zero records.
 */
export function decisionReportOf(records: readonly DecisionRecord[], options: DecisionReportOptions = {}): DecisionReport {
  const sorted = [...records].sort((a, b) => byCodePoint(a.id, b.id));
  const entries: DecisionPublicEntry[] = [];
  const counts = emptyCounts();
  for (const record of sorted) {
    const visible = options.allow === undefined
      ? record.audience.length === 0
      : record.audience.every((audience) => options.allow!.includes(audience));
    if (!visible) continue;
    entries.push(publicDecisionOf(record, { ...(options.allow === undefined ? {} : { allow: options.allow }) }));
    counts[record.status] += 1;
  }
  const visibleIds = new Set(entries.map((entry) => entry.id));
  return {
    version: 1,
    source: {
      ...(options.build === undefined ? {} : { build: options.build }),
    },
    entries: sortPublicEntries(entries),
    counts,
    unresolvedEvidence: unresolvedEvidenceOf(sorted).filter((entry) => visibleIds.has(entry.decision)),
    problems: [...(options.problems ?? [])],
  };
}
