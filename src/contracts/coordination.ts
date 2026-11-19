/**
 * The versioned coordination contract for multi-agent work (#1193-#1203).
 *
 * A parent task is split into subtasks; each subtask names its owner, its semantic scope, its
 * acceptance criteria, and the subtasks it depends on. A lease records who may write that scope
 * against which snapshot until when. Evidence, context packs, and proofs stay attached to the
 * subtask that produced them, so combining results never mixes two snapshots.
 *
 * Every id is derived from content and every order is derived from the dependency graph with a
 * stable tie-break, so the same input gives the same plan and the same merge. Nothing here reads a
 * clock or a file; a lease takes the caller's `nowMs` explicitly.
 */
import type { EditTransactionScope } from "./edit-transaction.ts";
import type { InteractionCheck, InteractionCheckpoint } from "./interaction.ts";
import type {
  TaskAcceptanceCriterion,
  TaskBudget,
  TaskBudgetStop,
  TaskPermissions,
  TaskProblem,
  TaskUsage,
} from "./task.ts";

/** The coordination format version. Only 1 exists. */
export type CoordinationVersion = 1;

/** One subtask split from a parent task. */
export interface CoordinationSubtask {
  /** SHA-256 over the parent id and the subtask key; stable across machines. */
  readonly id: string;
  /** The caller's short key, unique in the plan. */
  readonly key: string;
  /** The registered parent task id. */
  readonly parent: string;
  /** The one agent allowed to hold the lease and write the scope. */
  readonly owner: string;
  /** What the subtask achieves, trimmed. */
  readonly goal: string;
  /** The pages, blocks, symbols, records, and files this subtask may change. */
  readonly scope: EditTransactionScope;
  /** The criteria that prove the subtask, in caller order. */
  readonly acceptance: readonly TaskAcceptanceCriterion[];
  /** The ids of the subtasks that must produce evidence first, sorted. */
  readonly dependsOn: readonly string[];
  /** The limits for this subtask, never larger than the parent's. */
  readonly budget: TaskBudget;
  /** The parent snapshot id every subtask is pinned to. */
  readonly snapshot: string;
  /** Who may read, write, or check the subtask. */
  readonly permissions: TaskPermissions;
}

/** The parent half of a plan: identity, snapshot, limits, and access. */
export interface CoordinationParent {
  readonly id: string;
  readonly goal: string;
  readonly snapshot: string;
  readonly budget: TaskBudget;
  readonly permissions: TaskPermissions;
  readonly acceptance: readonly TaskAcceptanceCriterion[];
}

/** One split: the parent, its subtasks sorted by id, and a dependency order. */
export interface CoordinationPlan {
  readonly version: CoordinationVersion;
  readonly parent: CoordinationParent;
  /** Sorted by id, so the plan bytes do not depend on caller order. */
  readonly subtasks: readonly CoordinationSubtask[];
  /** Every subtask id in dependency order, smaller id first among equal prerequisites. */
  readonly order: readonly string[];
}

/** The result of splitting untrusted subtask input. */
export interface CoordinationSplitResult {
  /** The plan, present exactly when `problems` is empty. */
  readonly plan?: CoordinationPlan;
  /** Every problem found, in document order. */
  readonly problems: readonly TaskProblem[];
}

/** One semantic reference a subtask owns. */
export interface CoordinationOwnership {
  readonly subtask: string;
  readonly kind: "page" | "block" | "symbol" | "record" | "file";
  readonly ref: string;
}

/** Two subtasks that name the same reference. */
export interface CoordinationOverlap {
  readonly kind: CoordinationOwnership["kind"];
  readonly ref: string;
  /** The two subtask ids, smaller first. */
  readonly subtasks: readonly [string, string];
  /** One sentence naming both subtasks and the reference. */
  readonly message: string;
}

/** Why a subtask may not start. */
export interface CoordinationStartBlocker {
  readonly code: "coordination.scope-overlap" | "coordination.not-ready" | "coordination.lease-held";
  readonly message: string;
  readonly other?: string;
}

/** What a start request found. */
export interface CoordinationStartResult {
  readonly ready: boolean;
  readonly blockers: readonly CoordinationStartBlocker[];
}

/** One lease: who owns a subtask's scope, against which snapshot, until when. */
export interface CoordinationLease {
  /** SHA-256 over the subtask, owner, snapshot, generation, and issue time. */
  readonly id: string;
  readonly subtask: string;
  readonly owner: string;
  readonly scope: EditTransactionScope;
  readonly snapshot: string;
  /** Milliseconds since the epoch, supplied by the caller. */
  readonly issuedAt: number;
  /** When the lease stops being renewable; `nowMs >= expiresAt` is expired. */
  readonly expiresAt: number;
  /** Increases by one each time the lease is reclaimed. */
  readonly generation: number;
}

/** A released or reclaimed lease, recorded so a later agent can see who held it. */
export interface CoordinationLeaseRelease {
  readonly version: 1;
  readonly lease: string;
  readonly subtask: string;
  readonly owner: string;
  readonly releasedAt: number;
  readonly status: "released" | "expired";
  readonly reason: string;
}

/** One lease operation's result. */
export interface CoordinationLeaseResult {
  readonly lease?: CoordinationLease;
  readonly release?: CoordinationLeaseRelease;
  readonly problems: readonly TaskProblem[];
}

/** One edit an agent made, as before-and-after hashes of one file. */
export interface CoordinationEdit {
  readonly file: string;
  readonly beforeHash: string;
  readonly afterHash: string;
}

/** What one agent did, and when; used to decide whether an expired lease is safe to reclaim. */
export interface CoordinationActivity {
  readonly agent: string;
  readonly at: number;
  readonly edits: readonly CoordinationEdit[];
}

/** The current tree state a reclaim checks before it takes an expired lease. */
export interface CoordinationState {
  readonly snapshot: string;
  /** Current SHA-256 by site-relative file; `null` for a file that is absent. */
  readonly files: Readonly<Record<string, string | null>>;
}

/** One check a reclaim ran. */
export interface CoordinationRecoveryCheck {
  readonly id: "expired" | "owner-quiet" | "state-unchanged" | "edits-preserved";
  readonly status: "passed" | "failed";
  readonly detail: string;
}

/** A reclaim of an expired lease, with the evidence it checked. */
export interface CoordinationLeaseReclaim {
  readonly version: 1;
  readonly lease: string;
  readonly subtask: string;
  readonly from: string;
  readonly to: string;
  readonly reclaimedAt: number;
  readonly snapshot: string;
  /** The edits the check found and kept; nobody deletes them. */
  readonly preserved: readonly CoordinationEdit[];
  readonly checks: readonly CoordinationRecoveryCheck[];
}

/** The result of trying to reclaim an expired lease. */
export interface CoordinationReclaimResult {
  readonly lease?: CoordinationLease;
  readonly reclaim?: CoordinationLeaseReclaim;
  /** Owner edits still present in the tree; a failed reclaim leaves every one of them alone. */
  readonly preserved: readonly CoordinationEdit[];
  readonly problems: readonly TaskProblem[];
}

/** How one subtask stands in the schedule. */
export type CoordinationSubtaskState = "waiting" | "ready" | "done" | "blocked" | "failed";

/** One subtask's scheduling row. */
export interface CoordinationScheduleRow {
  readonly subtask: string;
  readonly state: CoordinationSubtaskState;
  /** Dependency ids that have no usable evidence. */
  readonly missing: readonly string[];
  /** Why the row has this state, in one sentence. */
  readonly reason: string;
}

/** One check result a subtask produces. */
export interface CoordinationCheck {
  readonly id: string;
  readonly status: "passed" | "failed" | "skipped";
}

/** The evidence one subtask produced. Nothing here is another subtask's evidence. */
export interface CoordinationEvidence {
  readonly subtask: string;
  readonly snapshot: string;
  /** A proof or report the parent can open. */
  readonly proof: string;
  readonly checks: readonly CoordinationCheck[];
  /** Transaction ids already applied, so a successor never repeats them. */
  readonly applied: readonly string[];
}

/** One duplicate pair, with the reasons it matched. */
export interface CoordinationDuplicateMatch {
  readonly subtask: string;
  readonly other: string;
  /** `goal`, `snapshot`, and `scope`, in that fixed order. */
  readonly reasons: readonly ("goal" | "snapshot" | "scope")[];
  /** One sentence naming the pair and the match. */
  readonly message: string;
}

/** What an explicit duplicate decision did. */
export type CoordinationDuplicateChoice = "merge" | "keep-separate";

/** A recorded duplicate decision; there is no implicit choice. */
export interface CoordinationDuplicateDecision {
  readonly version: 1;
  readonly subtask: string;
  readonly other: string;
  readonly choice: CoordinationDuplicateChoice;
  readonly reason: string;
}

/** One subtask's compiled context pack. */
export interface CoordinationPack {
  readonly subtask: string;
  readonly snapshot: string;
  /** The pack id or hash. */
  readonly pack: string;
}

/** One subtask's verification proof. */
export interface CoordinationProof {
  readonly subtask: string;
  readonly snapshot: string;
  /** The proof reference or hash. */
  readonly proof: string;
  readonly verdict: "proved" | "incomplete" | "failed";
  readonly checks: readonly CoordinationCheck[];
}

/** What the parent may consume from one subtask after authorization. */
export interface CoordinationAggregateEntry {
  readonly subtask: string;
  readonly snapshot: string;
  readonly authorized: boolean;
  /** Present only when the parent may read the subtask. */
  readonly goal?: string;
  /** Present only when the pack is authorized, relevant, and from the same snapshot. */
  readonly pack?: string;
  /** Present only when the proof is authorized, relevant, and from the same snapshot. */
  readonly proof?: string;
  readonly verdict?: "proved" | "incomplete" | "failed";
  readonly checks: readonly CoordinationCheck[];
}

/** The parent's authorized view of its subtasks. */
export interface CoordinationAggregate {
  readonly version: 1;
  readonly parent: string;
  readonly snapshot: string;
  readonly entries: readonly CoordinationAggregateEntry[];
  /** Every snapshot an input named, sorted; more than one means evidence was kept apart. */
  readonly snapshots: readonly string[];
  readonly problems: readonly TaskProblem[];
}

/** One file a subtask changed. A `null` hash means the file was absent on that side. */
export interface CoordinationFileResult {
  readonly file: string;
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
}

/** What one subtask finished with. */
export interface CoordinationSubtaskResult {
  readonly subtask: string;
  readonly snapshot: string;
  /** When the agent finished. It is a measurement and never affects the order. */
  readonly finishedAt?: number;
  /** Changed files, sorted by path. */
  readonly files: readonly CoordinationFileResult[];
  /** Transaction ids applied by this subtask, in apply order. */
  readonly transactions: readonly string[];
  /** Evidence references that support the result. */
  readonly evidence: readonly string[];
  /** The unified diff for this subtask, or a reference when a caller keeps the diff elsewhere. */
  readonly diff: string;
}

/** Why two results cannot be combined without a person or the parent deciding. */
export interface CoordinationMergeConflict {
  readonly kind: "same-file" | "stale-before" | "snapshot" | "missing-result" | "unknown-result" | "duplicate-result";
  /** The subtask ids on both sides, sorted; one id for a missing or unknown result. */
  readonly subtasks: readonly string[];
  readonly file?: string;
  readonly message: string;
}

/** One subtask in merge order. */
export interface CoordinationMergeEntry {
  readonly subtask: string;
  readonly transactions: readonly string[];
  readonly files: readonly CoordinationFileResult[];
}

/** The deterministic combination of subtask results. */
export interface CoordinationMerge {
  readonly version: 1;
  readonly parent: string;
  readonly snapshot: string;
  /** Dependency order, then stable id; never finish time. */
  readonly order: readonly CoordinationMergeEntry[];
  /** The final hash per file, sorted by path; `null` means the file is absent. */
  readonly files: readonly { readonly file: string; readonly hash: string | null }[];
  readonly conflicts: readonly CoordinationMergeConflict[];
  /** SHA-256 over the order, files, conflicts, and snapshot; finish times are not part of it. */
  readonly id: string;
}

/** One side of an escalation: its diff, evidence, and the files it claims. */
export interface CoordinationEscalationSide {
  readonly subtask: string;
  readonly snapshot: string;
  readonly diff: string;
  readonly evidence: readonly string[];
  readonly files: readonly CoordinationFileResult[];
}

/** A conflict sent to the parent task or a person; it starts unresolved and has no winner. */
export interface CoordinationEscalation {
  readonly version: 1;
  readonly id: string;
  readonly parent: string;
  readonly target: "parent" | "human";
  readonly conflicts: readonly CoordinationMergeConflict[];
  /** Both sides, in stable subtask order. */
  readonly sides: readonly CoordinationEscalationSide[];
  readonly status: "open" | "resolved";
  /** Present only after an explicit decision; never chosen by arrival order. */
  readonly decision?: {
    readonly choice: "left" | "right";
    readonly subtask: string;
    readonly reason: string;
  };
}

/** What escalating a merge produced. */
export interface CoordinationEscalationResult {
  readonly escalation?: CoordinationEscalation;
  readonly problems: readonly TaskProblem[];
}

/** A replacement agent's handoff: checkpoint, lease, pack, checks, and applied work. */
export interface CoordinationHandoff {
  readonly version: 1;
  readonly subtask: string;
  readonly from: string;
  readonly to: string;
  readonly snapshot: string;
  /** The lease, now owned by `to`. */
  readonly lease: CoordinationLease;
  readonly checkpoint: InteractionCheckpoint;
  readonly pack: string;
  readonly checks: readonly InteractionCheck[];
  /** Transaction ids already applied; the replacement must not repeat them. */
  readonly applied: readonly string[];
  /** `blocked` when a check failed or the handoff is incomplete. */
  readonly status: "ready" | "blocked";
}

/** What accepting a handoff lets the replacement do. */
export interface CoordinationResume {
  readonly subtask: string;
  readonly snapshot: string;
  readonly next: string;
  readonly pack: string;
  readonly checks: readonly InteractionCheck[];
  /** Transaction ids to skip; never apply one of these again. */
  readonly skip: readonly string[];
  readonly status: "ready" | "blocked";
}

/** One subtask's usage, for the shared parent budget. */
export interface CoordinationUsageRow {
  readonly subtask: string;
  readonly usage: TaskUsage;
}

/** The parent budget after every subtask is accounted for. */
export interface CoordinationBudgetReport {
  readonly version: 1;
  readonly parent: string;
  readonly budget: TaskBudget;
  /** One row per subtask, sorted by id. */
  readonly rows: readonly CoordinationUsageRow[];
  readonly total: TaskUsage;
  readonly stops: readonly TaskBudgetStop[];
  readonly within: boolean;
}
