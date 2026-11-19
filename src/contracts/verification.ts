/**
 * The versioned verification proof contract (#1189) and the public input an independent
 * verifier may use (#1186).
 *
 * Version 2 is one record for one task: the task and its plan, the input snapshot it ran
 * against, the transaction that changed files, the bounds and output hashes of every check,
 * the reproduced output hashes, the human-review state, and the claims that tie each
 * acceptance criterion to evidence. Version 1 is the existing edit proof in
 * `./edit-audit.ts` and `../edits/proof.ts`; `mizzen edit verify` still reads it, so adding
 * version 2 did not remove the older consumer.
 *
 * Every field describes content, never a machine: paths are relative with forward slashes,
 * checks keep output hashes instead of raw output, and there is no timestamp field. The proof
 * hash in `proofHash` is the SHA-256 of the canonical record without that field, so two
 * identical runs produce the same bytes and the same hash (#1190).
 */

/** The proof format this module writes. Version 1 remains readable through the edit proof path. */
export const VERIFICATION_PROOF_VERSION = 2;

/** One source span, 1-based lines and columns, the end inclusive. */
export interface VerificationSpan {
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
}

/** How one acceptance criterion is proved: by a check, or only by a person. */
export type VerificationMode = "check" | "human";

/** One criterion in a verification plan, with the check, fixture, and expected evidence it names. */
export interface VerificationPlanEntry {
  /** The criterion id from the task contract. */
  readonly criterion: string;
  /** What must be true, copied from the task contract. */
  readonly statement: string;
  /** `check` can pass automatically; `human` never can. */
  readonly mode: VerificationMode;
  /** The check that proves the criterion, for `check` mode. */
  readonly check?: string;
  /** The site-relative fixture the check reads or changes. */
  readonly fixture: string;
  /** The evidence a passing result must contain, in one sentence. */
  readonly expected: string;
}

/** Why a criterion could not be planned. A plan with any problem cannot prove its task. */
export interface VerificationPlanProblem {
  readonly criterion: string;
  readonly code: string;
  readonly message: string;
}

/** The plan built from a task: one entry per acceptance criterion, in contract order. */
export interface VerificationPlan {
  readonly version: 1;
  readonly task: string;
  readonly snapshot: string;
  readonly entries: readonly VerificationPlanEntry[];
  readonly problems: readonly VerificationPlanProblem[];
}

/** How one check ended. `unrun` is explicit so a missing run is never read as a pass. */
export type VerificationCheckStatus = "passed" | "failed" | "timed-out" | "rejected" | "unrun";

/** The bounds a check ran under. */
export interface VerificationLimits {
  readonly timeoutMs: number;
  readonly memoryMb: number;
  readonly network: "allow" | "deny";
  /** `sandbox` means the check's working folder was a fresh temporary folder. */
  readonly paths: "sandbox";
}

/** One bounded check, linked to the task, snapshot, and commit it ran for. */
export interface VerificationCheck {
  /** Stable check id, unique in the proof. */
  readonly id: string;
  /** The acceptance criterion this check proves. */
  readonly criterion: string;
  /** The task id the check ran for. */
  readonly task: string;
  /** The input snapshot id the check ran against. */
  readonly snapshot: string;
  /** The commit the check ran at. */
  readonly commit: string;
  readonly status: VerificationCheckStatus;
  /** The command, without machine-local paths. */
  readonly command: readonly string[];
  /** SHA-256 of what the check printed. */
  readonly outputHash: string;
  /** SHA-256 of the output the check expected, when it compares one. */
  readonly expectedHash?: string;
  readonly limits: VerificationLimits;
  /** Where a failing example lives, when the check read a source snippet. */
  readonly span?: VerificationSpan & { readonly file: string };
  /** One stable sentence about a failure; never raw output. */
  readonly detail?: string;
}

/** One file the transaction changed. A `null` hash means the file was absent on that side. */
export interface VerificationChange {
  readonly path: string;
  readonly before: string | null;
  readonly after: string | null;
}

/** A comparison of the files before and after the task. */
export interface VerificationScope {
  readonly allowed: readonly string[];
  readonly expected: readonly string[];
  /** Every changed file, sorted by path. */
  readonly changes: readonly VerificationChange[];
  /** Changed files the task scope did not allow. */
  readonly outOfScope: readonly string[];
  /** Changed files the task did not say it would change. */
  readonly unexpected: readonly string[];
  readonly ok: boolean;
}

/** One kind of stable reference a task may remove or redirect. */
export type VerificationReferenceKind = "url" | "block" | "redirect";

/** One reference problem. */
export interface VerificationReferenceIssue {
  readonly code: string;
  readonly kind: VerificationReferenceKind;
  readonly ref: string;
  readonly message: string;
}

/** The before-and-after reference check (#1185). */
export interface VerificationReferences {
  readonly ok: boolean;
  readonly removed: readonly string[];
  readonly changed: readonly string[];
  readonly invalid: readonly string[];
  readonly issues: readonly VerificationReferenceIssue[];
}

/** One difference between the recorded build and the reproduced build. */
export interface VerificationDifference {
  readonly category: "inputs" | "config" | "tools" | "environment" | "outputs";
  readonly path: string;
  readonly before?: string;
  readonly after?: string;
}

/** The reproduced output hashes and the differences that explain them (#1182). */
export interface VerificationOutputs {
  /** SHA-256 of the task's four input hashes. */
  readonly inputHash: string;
  readonly tool: { readonly expected: string; readonly actual: string };
  readonly expectedHash: string;
  readonly actualHash: string;
  readonly match: boolean;
  readonly explained: readonly VerificationDifference[];
  /** Differences no declared input, config, tool, or environment value explains. */
  readonly unexplained: readonly VerificationDifference[];
}

/** The human review state. A `human` criterion is proved only by `approved`. */
export type VerificationHumanStatus = "not-required" | "pending" | "approved" | "rejected";

/** The review evidence the proof keeps; the reviewer is optional so a proof never needs a name. */
export interface VerificationHumanReview {
  readonly status: VerificationHumanStatus;
  readonly criteria: readonly string[];
  readonly reviewer?: string;
}

/** One piece of evidence a claim may cite. */
export type VerificationEvidence =
  | { readonly kind: "file"; readonly path: string; readonly hash: string }
  | { readonly kind: "record"; readonly path: string; readonly hash: string }
  | { readonly kind: "span"; readonly path: string; readonly hash: string; readonly span: VerificationSpan }
  | {
      readonly kind: "check";
      readonly id: string;
      readonly status: VerificationCheckStatus;
      readonly outputHash: string;
    }
  | {
      readonly kind: "human";
      readonly criterion: string;
      readonly status: VerificationHumanStatus;
      readonly reviewer?: string;
    };

/** How one claim stands. */
export type VerificationClaimStatus = "proved" | "failed" | "unproven" | "needs-review";

/** One result claim, tied to evidence or to the evidence it is missing (#1180). */
export interface VerificationClaim {
  readonly id: string;
  readonly criterion: string;
  readonly statement: string;
  readonly status: VerificationClaimStatus;
  readonly evidence: readonly VerificationEvidence[];
  /** What the claim needs but does not have; empty only when the claim is proved. */
  readonly missing: readonly string[];
}

/** The transaction that produced the result: where it started, where it ended, and every changed file. */
export interface VerificationTransaction {
  /** SHA-256 over the task, snapshot, commits, and changed files. */
  readonly id: string;
  readonly commit: string;
  readonly base: string;
  readonly files: readonly VerificationChange[];
}

/** The task part of a proof: its identity and its planned criteria. */
export interface VerificationTask {
  readonly id: string;
  readonly goal: string;
  readonly criteria: readonly VerificationPlanEntry[];
}

/** The release package the receipt is bound to (#1191). */
export interface VerificationPackage {
  readonly commit: string;
  readonly tarballSha256: string;
  readonly ci: "passed" | "failed" | "unknown";
}

/** What the proof as a whole supports. A success result is never written over another verdict. */
export type VerificationVerdict = "proved" | "incomplete" | "failed";

/** The versioned proof record. */
export interface VerificationProof {
  readonly version: typeof VERIFICATION_PROOF_VERSION;
  readonly task: VerificationTask;
  readonly snapshot: {
    readonly content: string;
    readonly data: string;
    readonly config: string;
    readonly tooling: string;
    readonly id: string;
  };
  readonly transaction: VerificationTransaction;
  readonly checks: readonly VerificationCheck[];
  readonly outputs: VerificationOutputs;
  readonly humanReview: VerificationHumanReview;
  readonly claims: readonly VerificationClaim[];
  readonly scope: VerificationScope;
  readonly references: VerificationReferences;
  readonly package?: VerificationPackage;
  readonly verdict: VerificationVerdict;
  /** SHA-256 of the canonical record without this field. */
  readonly proofHash: string;
}

/** One check's public result, supplied by a verifier that reran it. */
export interface VerificationCheckEvidence {
  readonly status: VerificationCheckStatus;
  readonly outputHash: string;
}

/** The public inputs an independent verifier may use besides the proof itself (#1186). */
export interface VerificationPublicInput {
  readonly commit?: string;
  readonly tarballSha256?: string;
  readonly ci?: "passed" | "failed" | "unknown";
  /** Site-relative path to the SHA-256 before the task, or `null` when absent. */
  readonly before?: Readonly<Record<string, string | null>>;
  /** Site-relative path to the SHA-256 after the task, or `null` when absent. */
  readonly files?: Readonly<Record<string, string | null>>;
  /** Check results from a rerun, by check id. */
  readonly checks?: Readonly<Record<string, VerificationCheckEvidence>>;
  /** The whole-output hash a verifier computed. */
  readonly outputHash?: string;
  /** Per-file output hashes a verifier computed. */
  readonly outputs?: Readonly<Record<string, string>>;
  readonly humanReview?: {
    readonly status: VerificationHumanStatus;
    readonly reviewer?: string;
  };
}

/** One reason an independent verification did not prove the result. */
export interface VerificationFailure {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

/** What an independent verifier rechecked, and whether it agrees with the producer. */
export interface IndependentVerification {
  readonly ok: boolean;
  /** The verdict the evidence supports, never the one the producer wrote. */
  readonly verdict: VerificationVerdict;
  readonly producerVerdict: VerificationVerdict;
  readonly agrees: boolean;
  readonly proofHash: "matched" | "mismatched";
  readonly checked: {
    readonly files: number;
    readonly checks: number;
    readonly outputs: boolean;
    readonly humanReview: boolean;
    readonly package: boolean;
  };
  readonly failures: readonly VerificationFailure[];
}

/** The result of binding a receipt to its commit, tarball, CI result, and inputs (#1191). */
export interface ReceiptVerification {
  readonly ok: boolean;
  readonly tarballSha256: string;
  readonly failures: readonly VerificationFailure[];
}
