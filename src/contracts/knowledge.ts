/**
 * Explicit knowledge status: how far a page, a record, or one of its fields can be trusted, and the scope that
 * limits the claim. The five statuses have distinct meanings and distinct schema values, and none of them is the
 * absence of a declaration: a subject that declares nothing is `missing`, which is reported separately.
 */
import type { SourcePos } from "./source.ts";

/**
 * How certain a subject is.
 *
 * - `unknown`: nothing establishes the answer either way; the engine must never present it as known.
 * - `unsupported`: the engine or the site cannot represent or perform the thing at all, which is not the same as
 *   not knowing it.
 * - `unverified`: a claim exists but no evidence has confirmed it.
 * - `not-applicable`: the question does not apply to this subject, because it has no such facet.
 * - `out-of-scope`: the answer is known to sit outside what this site declares it is responsible for.
 */
export type KnowledgeStatus = "unknown" | "unsupported" | "unverified" | "not-applicable" | "out-of-scope";

/** The two statuses a verification criterion may rest on and that a proof may never mark verified. */
export type KnowledgeClaimStatus = "unknown" | "unverified";

/** What a declared scope limits the claim to. */
export type KnowledgeScopeKind = "surface" | "behavior" | "platform" | "version";

/** One dimension a declaration is limited to, such as the platform `windows` or the version `v2`. */
export interface KnowledgeScope {
  /** The dimension the limit names. */
  readonly kind: KnowledgeScopeKind;
  /** The value on that dimension, non-empty. */
  readonly value: string;
}

/** Where a declaration points readers for evidence. The value is private until the declaration says otherwise. */
export interface KnowledgeCitation {
  /** The address or identifier of the evidence. */
  readonly value: string;
  /** `true` publishes {@link KnowledgeCitation.value}; absent keeps it private and redacted in public output. */
  readonly public?: boolean;
}

/**
 * One explicit declaration read from front matter or a collection field. The declaration is the author's statement
 * that a subject is not simply documented: {@link KnowledgeDeclaration.status} says how, {@link KnowledgeDeclaration.scope}
 * says where, and {@link KnowledgeDeclaration.span} is the exact place it was written.
 */
export interface KnowledgeDeclaration {
  /** How certain the subject is. */
  readonly status: KnowledgeStatus;
  /** The dimensions the claim is limited to; empty means it applies everywhere. */
  readonly scope: readonly KnowledgeScope[];
  /** Why the subject has this status, in the author's words; private unless `public` is true. */
  readonly rationale?: string;
  /** Where the evidence is; its value is redacted in public output unless the citation is public. */
  readonly citation?: KnowledgeCitation;
  /** `true` publishes the rationale; absent keeps it private and replaces it with a placeholder. */
  readonly public?: boolean;
  /** `YYYY-MM-DD` after which the declaration must be reviewed; the clock is never read to decide this. */
  readonly expires?: string;
  /** The evidence the declaration was written against; a different current value flags it for review. */
  readonly evidence?: string;
  /** The exact source span of the declaration. */
  readonly span: SourcePos;
}

/** Which kind of subject a declaration belongs to. */
export type KnowledgeSubjectKind = "page" | "record";

/** One subject identified without naming its content, so a report can point at it. */
export interface KnowledgeSubject {
  readonly kind: KnowledgeSubjectKind;
  /** The page source path, or `<collection>/<id>` for a record. */
  readonly id: string;
}

/** Whether a subject declares a status at all: `missing` is never one of the five statuses. */
export type KnowledgePresence = "declared" | "missing";

/** A subject's knowledge, with the absence of a declaration kept explicit. */
export interface KnowledgeState {
  readonly presence: KnowledgePresence;
  /** Present exactly when {@link KnowledgeState.presence} is `declared`. */
  readonly declaration?: KnowledgeDeclaration;
}

/** Why a declaration needs review, in a fixed order. */
export type KnowledgeReviewReason = "expired" | "evidence-changed";

/** The review state of one declaration, computed against a fixed reference date and evidence value. */
export interface KnowledgeReview {
  /** True when the declaration must be reviewed before it is trusted again. */
  readonly required: boolean;
  /** Every reason it needs review, in the order expired, evidence-changed. */
  readonly reasons: readonly KnowledgeReviewReason[];
  /** The declaration's expiry date, when it has one. */
  readonly expires?: string;
}

/**
 * The public form of one declaration: the status, its scope, the review state, and the span are always published.
 * The rationale and the citation value appear only when the author marked them public; otherwise each private value
 * is replaced with a fixed placeholder, so no part of it reaches a public output.
 */
export interface KnowledgePublicDeclaration {
  readonly status: KnowledgeStatus;
  readonly scope: readonly KnowledgeScope[];
  /** The rationale, or {@link KnowledgePublicDeclaration.redacted} placeholder; absent when none is written. */
  readonly rationale?: string;
  /** The published citation, or the placeholder; absent when none is written. */
  readonly citation?: string;
  readonly review: {
    readonly required: boolean;
    readonly reasons: readonly KnowledgeReviewReason[];
  };
  /** The declaration's span, `path:line:column-endLine:endColumn`. */
  readonly span: string;
  readonly expires?: string;
  /** True when a private rationale or citation was replaced with its placeholder. */
  readonly redacted: boolean;
}

/** One subject's row in a knowledge report. A row is written for every subject, declared or not. */
export interface KnowledgeReportEntry {
  readonly subject: KnowledgeSubject;
  /** How a subject's declaration is kept in public output, or absent when it declares none. */
  readonly declaration?: KnowledgePublicDeclaration;
  /** The exact span of the declaration, or of the subject when it declares none. */
  readonly span: string;
}

/**
 * One way a subject's knowledge is deficient, with a kind that keeps three cases apart: an explicit `unknown`, a
 * `documentation-gap` for a subject that declares nothing, and `unsupported` for a case the site cannot handle.
 */
export type KnowledgeGapKind = "unknown" | "documentation-gap" | "unsupported";

/** One gap the report names. */
export interface KnowledgeGap {
  readonly subject: KnowledgeSubject;
  readonly kind: KnowledgeGapKind;
  /** The declared status, or `missing` for a documentation gap. */
  readonly status: KnowledgeStatus | "missing";
  /** The declaration's span, or the subject's own span when it declares none. */
  readonly span: string;
  /** True when the declaration that produced this row needs review. */
  readonly review: boolean;
}

/** One count by status, including `missing` for subjects that declare nothing. */
export interface KnowledgeCounts {
  readonly unknown: number;
  readonly unsupported: number;
  readonly unverified: number;
  readonly "not-applicable": number;
  readonly "out-of-scope": number;
  /** Subjects that declare no status at all, kept apart from every declared status. */
  readonly missing: number;
}

/** Where one knowledge report came from. */
export interface KnowledgeReportSource {
  /** The documentation build identity, absent when the report is read outside a build. */
  readonly build?: string;
  /** The explicit as-of date review was measured against, absent when none was set. */
  readonly asOf?: string;
}

/** One versioned knowledge report: every subject's state, the gaps, and the counts. */
export interface KnowledgeReport {
  readonly version: 1;
  readonly source: KnowledgeReportSource;
  /** Every subject, sorted by kind then id. */
  readonly entries: readonly KnowledgeReportEntry[];
  /** Every gap, in report order. */
  readonly gaps: readonly KnowledgeGap[];
  readonly counts: KnowledgeCounts;
}

/** One subject whose presence or declaration changed between two reports. */
export interface KnowledgeChange {
  readonly subject: KnowledgeSubject;
  /** `added`, `removed`, or `changed`; the kind of `changed` is in {@link KnowledgeChange.from} and `.to`. */
  readonly change: "added" | "removed" | "changed";
  /** The earlier presence-or-status, absent for `added`. */
  readonly from?: KnowledgeStatus | "missing";
  /** The later presence-or-status, absent for `removed`. */
  readonly to?: KnowledgeStatus | "missing";
}

/** The comparison of a report with an earlier one. */
export interface KnowledgeComparison {
  readonly version: 1;
  /** The earlier report's build identity, when it had one. */
  readonly baseline?: string;
  /** The later report's build identity, when it has one. */
  readonly current?: string;
  /** Every changed subject, sorted by kind then id. */
  readonly changes: readonly KnowledgeChange[];
  /** The count difference per status, `current` minus `baseline`. */
  readonly delta: KnowledgeCounts;
}
