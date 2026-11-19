/**
 * A versioned contract for one multi-file edit transaction (#1163).
 *
 * A transaction names the task that asks for the edit, the input snapshot it was planned against,
 * the per-file patches, the semantic scope the task may touch, the invariants the result must keep,
 * and the preconditions the writer enforces. `parseEditTransaction` in
 * `../edits/edit-transaction.ts` validates untrusted input into this shape before any file is read
 * or written; the writer applies the whole set or nothing.
 *
 * Everything a transaction needs to be checked is in the document: a planner that loses a hash, a
 * span, or an invariant cannot silently turn the edit into an unchecked write.
 */

/** The transaction format version. Only 1 exists. */
export type EditTransactionVersion = 1;

/** One source span, 1-based lines and columns with an inclusive end. */
export interface EditTransactionSpan {
  /** The file the span belongs to; omitted inside a file entry, where the enclosing `file` names it. */
  readonly file?: string;
  /** Line where the replaced text starts. */
  readonly line: number;
  /** Column where the replaced text starts, in Unicode code points. */
  readonly column: number;
  /** Line where the replaced text ends. */
  readonly endLine: number;
  /** Column of the span's last character, inclusive. */
  readonly endColumn: number;
}

/** One replacement on one file. */
export interface EditTransactionPatch {
  /** The text to replace. */
  readonly span: EditTransactionSpan;
  /** The text the span held when the patch was planned. */
  readonly expected?: string;
  /** The text that takes the span's place; the empty string deletes it. */
  readonly replacement: string;
  /** SHA-256 of the whole file the patch was computed from. */
  readonly beforeHash?: string;
}

/** One file and every patch that applies to it. */
export interface EditTransactionFile {
  /** The file relative to the site root, with forward slashes. */
  readonly file: string;
  /** The patches for this file; they may not share or overlap a span. */
  readonly patches: readonly EditTransactionPatch[];
}

/** The task the transaction was planned for. */
export interface EditTransactionTask {
  /** The registered task id, or a caller-stable task key. */
  readonly id: string;
  /** The request id the task was registered under, when it has one. */
  readonly requestId?: string;
  /** The task goal, in one sentence. */
  readonly goal?: string;
}

/** The input snapshot the transaction was planned against. */
export interface EditTransactionSnapshot {
  /** SHA-256 over the sorted file hashes, computed by the parser. */
  readonly id?: string;
  /** The SHA-256 of every input file, keyed by path relative to the site root. */
  readonly files: Readonly<Record<string, string>>;
}

/** What the writer must check before applying. */
export interface EditTransactionPreconditions {
  /** Refuse a patch that carries no `beforeHash`. */
  readonly requireBeforeHash: boolean;
  /** Parse the edited content and check its front matter and source positions before activation. */
  readonly validateContent: boolean;
  /** The source commit the transaction expects; recorded in the receipt. */
  readonly commit?: string;
}

/** The semantic references the task reserves. Every list is present; an unused one is empty. */
export interface EditTransactionScope {
  /** Page URLs, source paths, or page ids. */
  readonly pages: readonly string[];
  /** Block ids, such as `install-steps`. */
  readonly blocks: readonly string[];
  /** Exported symbol names, such as `build` or `Site.page`. */
  readonly symbols: readonly string[];
  /** Record references, such as `blog/hello` or a collection name. */
  readonly records: readonly string[];
  /** Files relative to the site root, with forward slashes. Empty means every patched file. */
  readonly files: readonly string[];
}

/** One invariant checked against the patched files before they become active. */
export type EditTransactionInvariant =
  | {
      /** Stable id, unique in the transaction. */
      readonly id: string;
      /** The text must survive in the file, such as a preserved URL. */
      readonly kind: "contains";
      readonly file: string;
      readonly text: string;
    }
  | {
      readonly id: string;
      /** The text must not appear in the file after the edit. */
      readonly kind: "absent";
      readonly file: string;
      readonly text: string;
    }
  | {
      readonly id: string;
      /** The text must be byte-identical somewhere in the file after the edit. */
      readonly kind: "unchanged";
      readonly file: string;
      readonly text: string;
    }
  | {
      readonly id: string;
      /** A JSON pointer in a JSON file must equal `value`. */
      readonly kind: "json-equals";
      readonly file: string;
      readonly pointer: string;
      readonly value: unknown;
    }
  | {
      readonly id: string;
      /** A JSON file must satisfy an inline JSON Schema. */
      readonly kind: "json-schema";
      readonly file: string;
      readonly schema: Readonly<Record<string, unknown>>;
    };

/** The normalized, validated transaction. */
export interface EditTransaction {
  /** The format version, always 1. */
  readonly version: EditTransactionVersion;
  /** SHA-256 over the transaction's identity; the same content gives the same id. */
  readonly id: string;
  /** The task the transaction belongs to. */
  readonly task: EditTransactionTask;
  /** The input snapshot, with its derived id. */
  readonly snapshot: EditTransactionSnapshot;
  /** The files to edit, each listed once. */
  readonly patches: readonly EditTransactionFile[];
  /** The invariants checked after patching and before activation. */
  readonly invariants: readonly EditTransactionInvariant[];
  /** What the writer enforces. */
  readonly preconditions: EditTransactionPreconditions;
  /** The semantic references the task reserves. */
  readonly scope: EditTransactionScope;
}

/** One reason a transaction document was refused. */
export interface EditTransactionProblem {
  /** JSON Pointer to the offending value, such as `/patches/0/span`; `""` is the whole document. */
  readonly path: string;
  /** Stable identifier, such as `transaction.duplicate-file`. */
  readonly code: string;
  /** What is wrong and what to write instead, in one sentence. */
  readonly message: string;
}

/** The result of parsing an untrusted transaction document. */
export interface EditTransactionParseResult {
  /** The validated transaction; present exactly when `problems` is empty. */
  readonly transaction?: EditTransaction;
  /** Every problem found, in document order; empty when the transaction is valid. */
  readonly problems: readonly EditTransactionProblem[];
}

/** Why an edit was refused or rolled back. */
export type EditTransactionConflictKind =
  | "span-overlap"
  | "stale-snapshot"
  | "stale-file"
  | "intent-lock"
  | "scope"
  | "boundary"
  | "rebase-missing"
  | "rebase-ambiguous";

/** One actionable refusal: both sides, where they meet, and what the caller can do next. */
export interface EditTransactionConflict {
  /** The kind of conflict. */
  readonly kind: EditTransactionConflictKind;
  /** The transaction being applied. */
  readonly task: string;
  /** The task that holds the other side, when it is known. */
  readonly otherTask?: string;
  /** The file the conflict is about, when it has one. */
  readonly file?: string;
  /** The two spans that overlap, when the conflict is about spans. */
  readonly spans?: readonly EditTransactionSpan[];
  /** What the caller can do: rebase onto the current snapshot, approve a low-confidence match, or resolve the edit. */
  readonly options: readonly ("rebase" | "approve" | "resolve")[];
  /** One sentence naming both sides without quoting either side's content. */
  readonly message: string;
}

/** One changed file after a successful transaction or a dry run. */
export interface EditTransactionFileResult {
  /** The file relative to the site root. */
  readonly file: string;
  /** SHA-256 of the file before the edit. */
  readonly beforeHash: string;
  /** SHA-256 of the file after the edit. */
  readonly afterHash: string;
  /** The replacements' spans in the new text. */
  readonly spans: readonly EditTransactionSpan[];
}

/** One invariant or content check and how it ended. */
export interface EditTransactionCheck {
  /** Stable check id. */
  readonly id: string;
  /** `passed`, `failed`, or `skipped`. */
  readonly status: "passed" | "failed" | "skipped";
  /** What the check found, without source text. */
  readonly message?: string;
}

/** The receipt a rollback reads: every file, its hashes, and the bytes it had before the edit. */
export interface EditTransactionReceipt {
  /** The receipt format version, always 1. */
  readonly version: 1;
  /** The transaction id. */
  readonly id: string;
  /** The task that applied it. */
  readonly task: EditTransactionTask;
  /** The snapshot the transaction was applied against. */
  readonly snapshot: EditTransactionSnapshot;
  /** The source commit the transaction named, when it named one. */
  readonly sourceCommit?: string;
  /** The proof record's path, relative to the site root when it is inside it. */
  readonly proof: string;
  /** The audit line ids the transaction wrote. */
  readonly audit: readonly string[];
  /** The changed files, sorted by path. */
  readonly files: readonly (EditTransactionFileResult & {
    /** The exact bytes before the edit, so a rollback needs nothing else. */
    readonly before: string;
  })[];
  /** The invariants that passed before activation. */
  readonly invariants: readonly string[];
  /** The date, when SOURCE_DATE_EPOCH or an explicit date supplied one. */
  readonly date?: string;
}

/** What a dry run or an applied transaction produced. */
export interface EditTransactionResult {
  /** True when nothing was written. */
  readonly dryRun: boolean;
  /** True only when every file, the proof, the ledger, and the receipt were committed. */
  readonly applied: boolean;
  /** The transaction id. */
  readonly id: string;
  /** The task id. */
  readonly task: string;
  /** The site root, absolute. */
  readonly siteRoot: string;
  /** The changed files, sorted by path. */
  readonly files: readonly EditTransactionFileResult[];
  /** The aggregate unified diff; present for a dry run. */
  readonly diff?: string;
  /** Every invariant and content check, in a fixed order. */
  readonly checks: readonly EditTransactionCheck[];
  /** The receipt's path, relative to the site root when it is inside it. */
  readonly receipt?: string;
  /** The proof's path. */
  readonly proof?: string;
  /** The audit line ids. */
  readonly audit?: readonly string[];
}

/** What a rollback by receipt did. */
export interface EditRollbackResult {
  /** The transaction id the receipt names. */
  readonly id: string;
  /** Files restored to their before bytes. */
  readonly restored: readonly string[];
  /** Files left alone because an independent edit changed them after the transaction. */
  readonly preserved: readonly string[];
}
