/**
 * Decision memory: versioned decision records (ADRs) and the answers a reader or an agent asks of them.
 *
 * A record is read once from a Markdown file with front matter, keeps the exact source position of every section it
 * publishes, and never invents a field. The record's text is kept beside its structure, so a rationale or a rejected
 * alternative can be quoted from the same bytes the author wrote.
 *
 * The lifecycle is five statuses with one relationship: `supersedes`. A supersession cycle is refused, and a query
 * answers the decision in effect at a version or snapshot, not simply the newest record.
 */
import type { SourcePos } from "./source.ts";

/** The five lifecycle statuses, in the order they are reported. */
export type DecisionStatus = "proposed" | "accepted" | "superseded" | "deprecated" | "rejected";

/** The kinds of public thing a decision can name as affected. */
export type DecisionLinkKind = "api" | "behavior" | "surface" | "collection" | "page";

/** The kinds of source change a decision can cite as evidence. */
export type DecisionEvidenceKind = "commit" | "pull-request" | "rfc" | "test";

/** `resolved` when the reference names something this build can see; `unknown` otherwise. */
export type DecisionEvidenceStatus = "resolved" | "unknown";

/** Where a decision came from: a URL, an issue, or an RFC. Private unless the author publishes it. */
export interface DecisionSource {
  /** The address or identifier. */
  readonly value: string;
  /** `true` publishes {@link DecisionSource.value}; absent keeps it private and redacted in public output. */
  readonly public?: boolean;
}

/** One stable identifier a decision says it affects, such as `page:guide/caching.md` or `collection:users`. */
export interface DecisionLink {
  readonly kind: DecisionLinkKind;
  /** The identifier inside its kind, such as `guide/caching.md` or `users`. */
  readonly id: string;
  /** The declaration as the author wrote it, such as `page:guide/caching.md`. */
  readonly raw: string;
  /** Where the link was written. */
  readonly pos?: SourcePos;
  /** `false` when the loader could not resolve the id against this build; absent when it never checked. */
  readonly resolved?: boolean;
}

/** One source change a decision cites, and whether this build could resolve it. */
export interface DecisionEvidence {
  readonly kind: DecisionEvidenceKind;
  /** The commit id, pull-request or RFC address, or test path. */
  readonly value: string;
  readonly status: DecisionEvidenceStatus;
  readonly pos?: SourcePos;
}

/** One piece of the original document: its exact text and the span it was read from. */
export interface DecisionText {
  readonly text: string;
  readonly span: SourcePos;
}

/** One alternative that was considered and not chosen, with the reason it was rejected. */
export interface DecisionAlternative {
  /** The alternative's name, from its heading. */
  readonly name: string;
  /** The alternative's whole section text, kept for citation. */
  readonly text: DecisionText;
  /** Why it was rejected, when the section states it; its text is the original paragraph. */
  readonly rejectedBecause?: DecisionText;
}

/**
 * When a decision applies: by documentation version, by an inclusive range of versions, or by build snapshot.
 * An absent key places no limit on that dimension; every key absent means the decision applies everywhere.
 */
export interface DecisionValidity {
  /** Version folders the decision applies to, such as `v1` and `v1.2`. */
  readonly versions?: readonly string[];
  /** Oldest version it applies to, inclusive. */
  readonly from?: string;
  /** Newest version it applies to, inclusive. */
  readonly until?: string;
  /** Build snapshots the decision applies to. */
  readonly snapshots?: readonly string[];
}

/** One parsed, versioned decision record. */
export interface DecisionRecord {
  /** The stable decision id, such as `ADR-0001`. */
  readonly id: string;
  readonly title: string;
  readonly status: DecisionStatus;
  /** The explicit `YYYY-MM-DD` day the decision was made. */
  readonly date: string;
  readonly source: DecisionSource;
  /** Decisions this one replaces, by id. */
  readonly supersedes: readonly string[];
  /** Decisions that replace this one, by id, declared or derived from other records' `supersedes`. */
  readonly supersededBy: readonly string[];
  readonly validity: DecisionValidity;
  readonly links: readonly DecisionLink[];
  readonly evidence: readonly DecisionEvidence[];
  /** The `Context` (or `Background`) section. */
  readonly context?: DecisionText;
  /** The `Decision` section. */
  readonly decision?: DecisionText;
  /** The `Rationale` (or `Why`, or `Consequences`) section. */
  readonly rationale?: DecisionText;
  readonly alternatives: readonly DecisionAlternative[];
  /** Audiences allowed to see the record at all; empty means public. */
  readonly audience: readonly string[];
  /** `true` publishes the rationale and the source value; absent keeps them private. */
  readonly public: boolean;
  /** The span of the whole record's front matter, so every finding can point at the file. */
  readonly span: SourcePos;
}

/** One decision as a public report publishes it: private values are replaced, never shortened or quoted. */
export interface DecisionPublicEntry {
  readonly id: string;
  readonly title: string;
  readonly status: DecisionStatus;
  readonly date: string;
  /** The source value, or a `[source withheld]` placeholder. */
  readonly source: string;
  readonly supersedes: readonly string[];
  readonly supersededBy: readonly string[];
  readonly validity: DecisionValidity;
  readonly links: readonly DecisionLink[];
  readonly evidence: readonly DecisionEvidence[];
  /** The alternatives with their rejection reasons, or placeholders for a private record. */
  readonly alternatives: readonly DecisionPublicAlternative[];
  /** The rationale, or a `[rationale withheld]` placeholder; absent when none is written. */
  readonly rationale?: string;
  readonly context?: string;
  readonly decision?: string;
  /** True when a private value was replaced with its placeholder. */
  readonly redacted: boolean;
  /** The record's span, `path:line:column-endLine:endColumn`. */
  readonly span: string;
}

/** One alternative in a public report: its name, reason, and the position of the original text. */
export interface DecisionPublicAlternative {
  readonly name: string;
  readonly rejectedBecause?: string;
  readonly span: string;
}

/** One lifecycle wound the report names, such as a supersession cycle. */
export interface DecisionProblem {
  /** A stable code, such as `decision.supersession-cycle`. */
  readonly id: string;
  readonly severity: "error" | "warning";
  readonly message: string;
  readonly span?: string;
}

/** The count of records by status. */
export interface DecisionCounts {
  readonly proposed: number;
  readonly accepted: number;
  readonly superseded: number;
  readonly deprecated: number;
  readonly rejected: number;
}

/** Where one decision report came from. */
export interface DecisionReportSource {
  /** The documentation build identity, absent outside a build. */
  readonly build?: string;
}

/** One versioned decision report: every record in public form, the counts, the unresolved evidence, and the problems. */
export interface DecisionReport {
  readonly version: 1;
  readonly source: DecisionReportSource;
  /** Every record, sorted by id. */
  readonly entries: readonly DecisionPublicEntry[];
  readonly counts: DecisionCounts;
  /** Evidence references this build could not resolve, by decision id. */
  readonly unresolvedEvidence: readonly { readonly decision: string; readonly value: string; readonly kind: DecisionEvidenceKind }[];
  /** Lifecycle problems, in stable order. A report with an error never presents a decision as current. */
  readonly problems: readonly DecisionProblem[];
}

/** What a "why" question names: a documentation version and a build snapshot, both optional. */
export interface DecisionQuery {
  readonly version?: string;
  readonly snapshot?: string;
}

/** One decision in a "why" answer, with the text a citation needs. */
export interface DecisionWhyEntry {
  readonly id: string;
  readonly title: string;
  readonly status: DecisionStatus;
  readonly date: string;
  /** The source value, or the placeholder when it is private and the caller is not authorized. */
  readonly source: string;
  readonly rationale?: string;
  readonly context?: string;
  readonly decision?: string;
  readonly alternatives: readonly DecisionPublicAlternative[];
  readonly links: readonly DecisionLink[];
  readonly evidence: readonly DecisionEvidence[];
  readonly validity: DecisionValidity;
  readonly supersedes: readonly string[];
  readonly supersededBy: readonly string[];
  /** True for the decision in effect at the queried version or snapshot. */
  readonly current: boolean;
  /** True when a private value was replaced with its placeholder. */
  readonly redacted: boolean;
  readonly span: string;
}

/** The answer to "why does this behavior or page exist": the current decision, its rationale and rejected
 * alternatives, and the decisions that came before, each with its citation. */
export interface DecisionWhy {
  readonly version: 1;
  /** The subject as the caller named it. */
  readonly subject: string;
  /** The version and snapshot the answer was resolved for. */
  readonly query: DecisionQuery;
  /** The decision in effect, absent when no decision applies or none is visible. */
  readonly current?: DecisionWhyEntry;
  /** Earlier decisions, newest first. */
  readonly history: readonly DecisionWhyEntry[];
  /** True when a current decision answers the question. */
  readonly answerable: boolean;
}
