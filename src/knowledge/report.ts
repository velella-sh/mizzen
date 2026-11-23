/**
 * Builds the versioned knowledge report: every subject's public declaration or an explicit `missing`, the gaps split
 * into explicit unknowns, documentation gaps, and unsupported cases, the counts, and a comparison with an earlier
 * report.
 *
 * The report is deterministic: subjects are sorted, the review state is measured against an explicit as-of date and an
 * explicit current evidence value, and the clock is never read. A private rationale or citation is replaced with its
 * placeholder before it reaches a report, so nothing here can publish a value the author kept private.
 */
import type { Site } from "../contracts/content.ts";
import type {
  KnowledgeComparison,
  KnowledgeCounts,
  KnowledgeGap,
  KnowledgeReport,
  KnowledgeReportEntry,
  KnowledgeStatus,
  KnowledgeSubject,
} from "../contracts/knowledge.ts";
import { sha256, canonicalJson } from "../data/lock.ts";
import { publicDeclarationOf } from "./public.ts";
import { reviewOf } from "./parse.ts";
import { formatSpan } from "../source/spans.ts";
import { knowledgeSubjectsOf, type KnowledgeSubjectEntry } from "./subjects.ts";

/** What a report needs besides the site. */
export interface KnowledgeReportOptions {
  /** The explicit as-of date, `YYYY-MM-DD`; review is never measured against the clock. */
  readonly asOf?: string;
  /** The documentation build identity, when the report comes from a build. */
  readonly build?: string;
  /** The current evidence value of a subject, so a declaration recorded against another one needs review. */
  readonly evidenceOf?: (subject: KnowledgeSubject) => string | undefined;
}

/** The zero counts, as a mutable accumulator the report fills and then returns as a frozen value. */
function emptyCounts(): { -readonly [K in keyof KnowledgeCounts]: number } {
  return { unknown: 0, unsupported: 0, unverified: 0, "not-applicable": 0, "out-of-scope": 0, missing: 0 };
}

/** The status a subject shows in a comparison: its declared status, or `missing`. */
function presenceOf(entry: KnowledgeSubjectEntry): KnowledgeStatus | "missing" {
  return entry.declaration?.status ?? "missing";
}

/** The current evidence of a subject: a page's Markdown, or a record's fields, as a SHA-256. */
export function evidenceOfSubject(site: Site, subject: KnowledgeSubject): string | undefined {
  if (subject.kind === "page") {
    const page = site.pages.find((candidate) => candidate.source.file === subject.id);
    return page === undefined ? undefined : sha256(page.markdown);
  }
  const at = subject.id.indexOf("/");
  if (at < 0) return undefined;
  const collection = site.collections[subject.id.slice(0, at)];
  const record = collection?.records.find((candidate) => candidate.id === subject.id.slice(at + 1));
  return record === undefined ? undefined : sha256(canonicalJson(record.fields));
}

/** Builds the report from the site. */
export function knowledgeReportOf(site: Site, options: KnowledgeReportOptions = {}): KnowledgeReport {
  const evidence = options.evidenceOf ?? ((subject: KnowledgeSubject) => evidenceOfSubject(site, subject));
  const entries: KnowledgeReportEntry[] = [];
  const gaps: KnowledgeGap[] = [];
  const counts = emptyCounts();

  for (const entry of knowledgeSubjectsOf(site)) {
    const span = formatSpan(entry.span);
    const declaration = entry.declaration;
    if (declaration === undefined) {
      entries.push({ subject: entry.subject, span });
      counts.missing += 1;
      gaps.push({ subject: entry.subject, kind: "documentation-gap", status: "missing", span, review: false });
      continue;
    }
    const currentEvidence = evidence(entry.subject);
    const review = reviewOf(declaration, {
      ...(options.asOf === undefined ? {} : { asOf: options.asOf }),
      ...(currentEvidence === undefined ? {} : { evidence: currentEvidence }),
    });
    entries.push({ subject: entry.subject, declaration: publicDeclarationOf(declaration, review), span });
    counts[declaration.status] += 1;
    if (declaration.status === "unknown" || declaration.status === "unsupported") {
      gaps.push({ subject: entry.subject, kind: declaration.status, status: declaration.status, span, review: review.required });
    }
  }

  return {
    version: 1,
    source: {
      ...(options.build === undefined ? {} : { build: options.build }),
      ...(options.asOf === undefined ? {} : { asOf: options.asOf }),
    },
    entries,
    gaps: sortGaps(gaps),
    counts,
  };
}

/** The report order of gaps: explicit unknowns, then unsupported cases, then documentation gaps, each by subject. */
function sortGaps(gaps: readonly KnowledgeGap[]): KnowledgeGap[] {
  const rank = (kind: KnowledgeGap["kind"]): number =>
    kind === "unknown" ? 0 : kind === "unsupported" ? 1 : 2;
  return [...gaps].sort(
    (a, b) =>
      rank(a.kind) - rank(b.kind) ||
      (a.subject.kind < b.subject.kind ? -1 : a.subject.kind > b.subject.kind ? 1 : 0) ||
      (a.subject.id < b.subject.id ? -1 : a.subject.id > b.subject.id ? 1 : 0),
  );
}

/** The key a subject is compared by. */
function subjectKey(subject: KnowledgeSubject): string {
  return `${subject.kind}\u0000${subject.id}`;
}

/**
 * Compares a report with an earlier one: every added, removed, or changed subject, and the count difference per
 * status. A subject whose build identity differs is still compared by subject, because that is what the reader wants.
 */
export function compareKnowledgeReports(
  baseline: KnowledgeReport,
  current: KnowledgeReport,
): KnowledgeComparison {
  const before = new Map(baseline.entries.map((entry) => [subjectKey(entry.subject), entry]));
  const after = new Map(current.entries.map((entry) => [subjectKey(entry.subject), entry]));
  const changes: { subject: KnowledgeSubject; change: "added" | "removed" | "changed"; from?: KnowledgeStatus | "missing"; to?: KnowledgeStatus | "missing" }[] = [];
  for (const [key, entry] of after) {
    const earlier = before.get(key);
    if (earlier === undefined) {
      changes.push({ subject: entry.subject, change: "added", to: entry.declaration?.status ?? "missing" });
      continue;
    }
    const from = earlier.declaration?.status ?? "missing";
    const to = entry.declaration?.status ?? "missing";
    if (from !== to) changes.push({ subject: entry.subject, change: "changed", from, to });
  }
  for (const [key, entry] of before) {
    if (after.has(key)) continue;
    changes.push({ subject: entry.subject, change: "removed", from: entry.declaration?.status ?? "missing" });
  }
  changes.sort(
    (a, b) => (a.subject.kind < b.subject.kind ? -1 : a.subject.kind > b.subject.kind ? 1 : 0) ||
      (a.subject.id < b.subject.id ? -1 : a.subject.id > b.subject.id ? 1 : 0),
  );
  const delta = emptyCounts();
  for (const key of Object.keys(delta) as (keyof KnowledgeCounts)[]) {
    delta[key] = current.counts[key] - baseline.counts[key];
  }
  return {
    version: 1,
    ...(baseline.source.build === undefined ? {} : { baseline: baseline.source.build }),
    ...(current.source.build === undefined ? {} : { current: current.source.build }),
    changes,
    delta,
  };
}
