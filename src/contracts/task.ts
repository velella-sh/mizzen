/**
 * A versioned contract for one task and the document that tracks its lifecycle.
 *
 * A contract states the goal, the semantic scope, the input snapshot, the budget, the permissions,
 * and the acceptance criteria. `parseTaskContract` in `../tasks/contract.ts` validates untrusted
 * input into this shape; `registerTask` in `../tasks/register.ts` assigns the deterministic ids and
 * the first event. Nothing here runs, reads a file, or calls a model.
 *
 * The snapshot is four SHA-256 hashes — effective content, data, config, and tooling — plus the id
 * derived from them. A material change to any of the four produces a different snapshot id, so a
 * task cannot silently continue against inputs it was not planned for.
 */

/** One task state. The first eight are the working states; the last four are terminal. */
export type TaskStatus =
  | "draft"
  | "ready"
  | "waiting"
  | "running"
  | "blocked"
  | "verify"
  | "done"
  | "failed"
  | "canceled"
  | "expired";

/** The semantic references a task may touch. Every list is present; an unused one is empty. */
export interface TaskScope {
  /** Page URLs, source paths, or page ids. */
  readonly pages: readonly string[];
  /** Block ids, such as `install-steps`. */
  readonly blocks: readonly string[];
  /** Collection names, such as `blog`. */
  readonly collections: readonly string[];
  /** Exported symbol names, such as `build` or `Site.page`. */
  readonly symbols: readonly string[];
  /** Files relative to the site root, with forward slashes. */
  readonly files: readonly string[];
}

/** The hashes that pin a task to its inputs, and the id derived from them. */
export interface TaskSnapshot {
  /** SHA-256 of the effective page content after includes and overrides. */
  readonly content: string;
  /** SHA-256 of the effective data the task may read. */
  readonly data: string;
  /** SHA-256 of the effective site configuration. */
  readonly config: string;
  /** SHA-256 of the engine and tool versions the task was planned with. */
  readonly tooling: string;
  /** SHA-256 over the four hashes; computed by the parser, never guessed. */
  readonly id: string;
}

/** Independent limits for a task. All three are required, so no limit is left implicit. */
export interface TaskBudget {
  /** Most estimated context tokens the task may use. */
  readonly contextTokens: number;
  /** Most tool calls the task may make. */
  readonly toolCalls: number;
  /** Most milliseconds the task may run. */
  readonly timeMs: number;
}

/** What a task has spent so far, in the same three dimensions as {@link TaskBudget}. */
export interface TaskUsage {
  readonly contextTokens: number;
  readonly toolCalls: number;
  readonly timeMs: number;
}

/** Who may read the task, request writes on its behalf, or request its checks. */
export interface TaskPermissions {
  /** Principals allowed to read the task; `*` means any. */
  readonly read: readonly string[];
  /** Principals allowed to request writes for the task; `*` means any. */
  readonly write: readonly string[];
  /** Principals allowed to request checks for the task; `*` means any. */
  readonly check: readonly string[];
}

/**
 * One acceptance criterion: an existing check id or an explicit human-review requirement. The two
 * are exclusive; a criterion with neither is refused, and neither is ever treated as proved
 * without the evidence the criterion names.
 */
export interface TaskAcceptanceCriterion {
  /** Stable criterion id, unique in the task. */
  readonly id: string;
  /** What must be true. */
  readonly statement: string;
  /** The id of an existing check that proves the criterion. */
  readonly check?: string;
  /** Explicitly requires human review; the criterion is never proved automatically. */
  readonly review?: true;
}

/** The versioned contract a caller registers. */
export interface TaskContract {
  /** The contract version, always `1`. */
  readonly version: 1;
  /** The caller's key for one registration. */
  readonly idempotencyKey: string;
  /** The task in one sentence, trimmed. */
  readonly goal: string;
  /** The semantic scope, with every list present. */
  readonly scope: TaskScope;
  /** The input snapshot, with its derived id. */
  readonly snapshot: TaskSnapshot;
  /** The independent limits. */
  readonly budget: TaskBudget;
  /** The access rules, with defaults filled. */
  readonly permissions: TaskPermissions;
  /** Executable criteria, in caller order. */
  readonly acceptance: readonly TaskAcceptanceCriterion[];
}

/**
 * One recorded transition. The first event registers the task (`from: null`, `to: "draft"`);
 * every later event names the state it left, the state it entered, why, and the result it produced.
 */
export interface TaskEvent {
  /** Zero-based position in the task's event list. */
  readonly sequence: number;
  /** The task the transition belongs to. */
  readonly taskId: string;
  /** The input snapshot id the transition ran against. */
  readonly snapshot: string;
  /** The state before the transition; `null` for registration. */
  readonly from: TaskStatus | null;
  /** The state after the transition. */
  readonly to: TaskStatus;
  /** Why the transition happened, trimmed. */
  readonly reason: string;
  /** A reference to the result the transition produced, or `null` when it produced none. */
  readonly result: string | null;
}

/** A registered task document: its contract, deterministic ids, state, and ordered events. */
export interface TaskDocument extends TaskContract {
  /** SHA-256 of the idempotency key; independent of time and local paths. */
  readonly id: string;
  /** SHA-256 of the normalized contract; the same content gives the same request id. */
  readonly requestId: string;
  /** The state after the last event. */
  readonly state: TaskStatus;
  /** The ordered transitions, starting with registration. */
  readonly events: readonly TaskEvent[];
}

/** One reason a contract, task, or transition was refused. */
export interface TaskProblem {
  /** JSON Pointer to the offending value, such as `/snapshot/id`; `""` is the whole document. */
  readonly path: string;
  /** Stable identifier, such as `task.scope-unknown`; never reused for another meaning. */
  readonly code: string;
  /** What is wrong and what to write instead, in one sentence. */
  readonly message: string;
}

/** The result of parsing a contract. */
export interface TaskParseResult {
  /** The validated contract; present exactly when `problems` is empty. */
  readonly contract?: TaskContract;
  /** Every problem found, in document order; empty when the contract is valid. */
  readonly problems: readonly TaskProblem[];
}

/** What one budget limit did when it was exceeded. */
export type TaskBudgetStopStatus =
  | "context-tokens-exceeded"
  | "tool-calls-exceeded"
  | "time-exceeded";

/** One exceeded budget limit, with its own status and a sentence that names both numbers. */
export interface TaskBudgetStop {
  readonly status: TaskBudgetStopStatus;
  readonly reason: string;
}

/** How one acceptance criterion stands against the evidence supplied for it. */
export type TaskCriterionOutcome = "proved" | "failed" | "pending" | "needs-review";

/** The evidence a caller supplies for one criterion. */
export interface TaskCriterionEvidence {
  /** The check that ran, when the criterion names one. */
  readonly check?: {
    readonly id: string;
    readonly status: "passed" | "failed" | "skipped";
  };
  /** The human decision, when the criterion requires review. */
  readonly review?: {
    readonly status: "approved" | "rejected";
  };
}

/** Whether a related task is a duplicate or a dependency of the query. */
export type TaskRelatedKind = "duplicate" | "dependent";

/** Why one related task matched. */
export interface TaskRelatedReason {
  readonly kind: TaskRelatedKind;
  /** What matched, without disclosing scope content the caller may not read. */
  readonly detail: string;
}

/** What to search for: a scope, a snapshot id, or both. */
export interface TaskRelatedQuery {
  /** The scope to compare. Absent means scope does not contribute a match. */
  readonly scope?: TaskScope;
  /** The input snapshot id to compare. Absent means the snapshot does not contribute a match. */
  readonly snapshot?: string;
}

/** One task that matches a related-task search. */
export interface TaskRelatedMatch {
  /** The matched task id. */
  readonly id: string;
  /** The matched request id. */
  readonly requestId: string;
  /** The matched task's current state. */
  readonly state: TaskStatus;
  /** Every reason the task matched, in a fixed order. */
  readonly reasons: readonly TaskRelatedReason[];
  /** True when the caller may not read this task's content; `goal` and `scope` are then absent. */
  readonly redacted: boolean;
  /** The goal, present only when the caller may read the task. */
  readonly goal?: string;
  /** The scope, present only when the caller may read the task. */
  readonly scope?: TaskScope;
}
