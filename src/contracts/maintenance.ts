/**
 * The maintenance contract (#1229-#1242): versioned triggers, drift-derived tasks, decisions
 * between deterministic fixes and agent work, constrained scope, compiled context, external
 * patches, previews, independent verification, stale-patch stops, pull-request recipes,
 * no-op detection, and the failure state that preserves the last good inputs.
 *
 * Everything here is data. No function in `../maintenance/` writes a source file or calls a
 * model; a patch is applied to text in memory, and a pull request is a recipe another tool may
 * create. The branch, title, body, evidence, and permissions are deterministic, so the same
 * inputs give the same bytes on every machine.
 */
import type { TaskDocument, TaskProblem, TaskScope, TaskSnapshot } from "./task.ts";
import type { DiagnosticFix } from "./diagnostic.ts";
import type { SourcePos } from "./source.ts";
import type {
  IndependentVerification,
  VerificationClaim,
  VerificationCheck,
  VerificationPlan,
  VerificationProof,
  VerificationScope,
  VerificationVerdict,
} from "./verification.ts";

/** The only maintenance trigger and patch version this module accepts. */
export const MAINTENANCE_VERSION = 1;

/** What kind of input changed. A schema, an API, and a record are not files. */
export type MaintenanceKind = "file" | "schema" | "api" | "data";

/** How a tracked input changed. */
export type MaintenanceChangeKind = "added" | "changed" | "removed";

/** One changed input, before it becomes a trigger. */
export interface MaintenanceChange {
  readonly kind: MaintenanceKind;
  /** A relative file path, schema id, API id, or record origin. */
  readonly source: string;
  readonly change: MaintenanceChangeKind;
  /** SHA-256 of the new content; absent for a removed input. */
  readonly sha256?: string;
  /** One sentence about the change, such as the exported name that moved. */
  readonly detail?: string;
}

/** One versioned trigger: what changed, where, and the input snapshot it was read against. */
export interface MaintenanceTrigger {
  readonly version: 1;
  /** SHA-256 over the kind, source, change, hash, and snapshot id. */
  readonly id: string;
  readonly kind: MaintenanceKind;
  readonly source: string;
  readonly change: MaintenanceChangeKind;
  /** A sentence a task goal can use; never empty. */
  readonly detail: string;
  readonly snapshot: TaskSnapshot;
}

/** What {@link maintenanceTriggers} returns. */
export interface MaintenanceTriggerResult {
  /** Unique triggers, sorted by source and kind. */
  readonly triggers: readonly MaintenanceTrigger[];
  /** Triggers that repeat an earlier id; a repeated event never becomes a second task. */
  readonly duplicates: readonly string[];
  readonly problems: readonly TaskProblem[];
}

/** One file behind a stale page. */
export interface MaintenanceFileChange {
  readonly path: string;
  readonly change: MaintenanceChangeKind;
}

/** A page whose covered files changed. */
export interface MaintenanceStaleness {
  /** Source path of the page, relative to the site root. */
  readonly page: string;
  readonly files: readonly MaintenanceFileChange[];
}

/** One drift finding at one page. */
export interface MaintenanceFinding {
  /** Source path of the page that makes the claim. */
  readonly page: string;
  /** Stable diagnostic id, such as `drift.missing-symbol`. */
  readonly id: string;
  readonly message: string;
  readonly pos?: SourcePos;
  /** A mechanical repair the drift check already knows, when there is one. */
  readonly fix?: DiagnosticFix;
}

/** One record whose data impact reaches published output and documentation. */
export interface MaintenanceImpact {
  readonly collection: string;
  readonly record: string;
  /** Source paths of the pages that describe the changed record. */
  readonly pages: readonly string[];
  /** Published outputs the change reaches, such as `/api/catalog/`. */
  readonly outputs: readonly string[];
}

/** Everything one maintenance run observed, in one versioned document. */
export interface MaintenanceObservations {
  readonly version: 1;
  readonly staleness: readonly MaintenanceStaleness[];
  readonly findings: readonly MaintenanceFinding[];
  readonly impact: readonly MaintenanceImpact[];
}

/** An observation that produced no task, with the reason. */
export interface MaintenanceSkip {
  readonly kind: "stale" | "finding" | "impact";
  readonly source: string;
  readonly reason: string;
}

/** One task proposed from drift. */
export interface MaintenanceTask {
  readonly version: 1;
  /** Stable id over the observation key and snapshot. */
  readonly id: string;
  /** The observation key, such as `stale:docs/guide.md`. */
  readonly trigger: string;
  /** True when this call registered the task; false when the key already addressed one. */
  readonly created: boolean;
  readonly task: TaskDocument;
}

/** What {@link proposeMaintenanceTasks} returns. */
export interface MaintenanceTaskResult {
  readonly tasks: readonly MaintenanceTask[];
  readonly skipped: readonly MaintenanceSkip[];
  readonly problems: readonly TaskProblem[];
}

/** Whether work needs a model: a mechanical fix, an agent, or nothing. */
export type MaintenanceMode = "deterministic" | "agent" | "none";

/** The reason one observation needs a deterministic fix, an agent, or nothing. */
export interface MaintenanceDecision {
  readonly mode: MaintenanceMode;
  /** One sentence that names the evidence behind the choice. */
  readonly reason: string;
  /** Finding ids whose diagnostic carries a safe mechanical repair. */
  readonly fixes: readonly string[];
  /** Finding ids that are ambiguous or semantic and need an agent. */
  readonly semantic: readonly string[];
}

/** A source file and the hash a patch was computed from. */
export interface MaintenanceBaseFile {
  readonly path: string;
  readonly sha256: string;
}

/** What a client says proves one acceptance criterion. */
export interface MaintenanceClaim {
  readonly criterion: string;
  readonly statement: string;
  /** Site-relative files the claim cites; each must be changed by the patch or already in scope. */
  readonly files: readonly string[];
  /** Check ids that prove the claim. */
  readonly checks: readonly string[];
}

/** One span replacement in an external patch. */
export interface MaintenancePatchEdit {
  /** Site-relative file path, with forward slashes. */
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
  /** The text the span held when the patch was computed. */
  readonly expected: string;
  /** What replaces the span; the empty string deletes it. */
  readonly replacement: string;
}

/** One file in an external patch, pinned to the hash it was computed from. */
export interface MaintenancePatchFile {
  readonly path: string;
  readonly sha256: string;
  readonly edits: readonly MaintenancePatchEdit[];
}

/**
 * The versioned patch document an external client submits. Mizzen validates it; it never
 * accepts instructions, a command, or a path outside the site.
 */
export interface MaintenancePatch {
  readonly version: 1;
  /** The task id the patch was written for. */
  readonly task: string;
  /** The task snapshot id the patch was written against. */
  readonly snapshot: string;
  /** The proposal id so a later run can pair the patch with its proposal. */
  readonly proposal: string;
  readonly files: readonly MaintenancePatchFile[];
  readonly claims: readonly MaintenanceClaim[];
}

/** One reason a trigger, patch, or preview was refused. */
export interface MaintenanceProblem {
  /** JSON Pointer to the offending value. */
  readonly path: string;
  /** Stable identifier, such as `maintenance.patch-stale`. */
  readonly code: string;
  /** What is wrong and what to submit instead. */
  readonly message: string;
}

/** The parsed patch, or every reason it was refused. */
export interface MaintenancePatchResult {
  readonly patch?: MaintenancePatch;
  readonly problems: readonly MaintenanceProblem[];
}

/** One changed file in a preview. */
export interface MaintenancePreviewFile {
  readonly path: string;
  /** SHA-256 before the patch. */
  readonly before: string;
  /** SHA-256 after the patch. */
  readonly after: string;
  /** The unified diff, empty when the patch changes nothing. */
  readonly diff: string;
  readonly changed: boolean;
}

/** One check the proposal's acceptance criteria require. */
export interface MaintenancePlannedCheck {
  readonly id: string;
  readonly criterion: string;
  /** `schema`, `links`, `examples`, `build`, or `task`. */
  readonly kind: string;
  readonly status: "planned";
}

/** Whether writing the preview is allowed, and why. */
export type MaintenanceWriteGate = "dry-run" | "requires-approval" | "allowed" | "denied";

/**
 * A preview that changed no source: the diff, the checks, and the affected outputs are all
 * computed from text, so a reviewer sees the result before anything is written.
 */
export interface MaintenancePreview {
  readonly version: 1;
  readonly proposal: string;
  readonly snapshot: string;
  readonly files: readonly MaintenancePreviewFile[];
  /** True when at least one file's bytes differ. */
  readonly changed: boolean;
  readonly checks: readonly MaintenancePlannedCheck[];
  readonly outputs: readonly string[];
  readonly write: MaintenanceWriteGate;
  readonly writeReason: string;
  /** Patch or source problems; a preview with any problem has no changed file. */
  readonly problems: readonly MaintenanceProblem[];
}

/** The check kinds a maintenance proposal may require. */
export type MaintenanceCheckKind = "schema" | "links" | "examples" | "build" | "task";

/** How one maintenance check ended. `skipped` is never a pass. */
export type MaintenanceCheckStatus = "passed" | "failed" | "skipped";

/** One check result supplied by the caller or a bounded runner. */
export interface MaintenanceCheck {
  readonly id: string;
  readonly kind: MaintenanceCheckKind;
  /** The acceptance criterion this check proves, when it proves one. */
  readonly criterion?: string;
  readonly status: MaintenanceCheckStatus;
  /** SHA-256 of what the check printed, when it printed anything. */
  readonly outputHash?: string;
  /** One stable sentence about a failure; never raw output. */
  readonly detail?: string;
}

/** One reason a maintenance proposal is not ready for merge. */
export interface MaintenanceVerificationFailure {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

/** What independent verification proved about one proposal. */
export interface MaintenanceVerification {
  readonly version: 1;
  readonly proposal: string;
  readonly snapshot: string;
  readonly plan: VerificationPlan;
  readonly claims: readonly VerificationClaim[];
  readonly scope: VerificationScope;
  readonly checks: readonly VerificationCheck[];
  readonly proof?: VerificationProof;
  readonly independent?: IndependentVerification;
  readonly verdict: VerificationVerdict;
  /** True only when every claim is proved, every check passed, and the proof is independent. */
  readonly ready: boolean;
  readonly failures: readonly MaintenanceVerificationFailure[];
}

/** One source that changed under a patch. */
export interface MaintenanceStaleSource {
  readonly path: string;
  readonly reason: "snapshot" | "missing" | "changed";
  readonly before: string;
  readonly current: string | null;
}

/** Whether a patch can still apply, and what to do when it cannot. */
export interface MaintenanceStaleResult {
  readonly ok: boolean;
  readonly stale: readonly MaintenanceStaleSource[];
  /** `rebase` asks for a new patch; `review` asks a person to look; `none` means fresh. */
  readonly action: "none" | "rebase" | "review";
  readonly reason: string;
  /** The task after it was moved to `blocked`, when it was. */
  readonly task?: TaskDocument;
}

/** The evidence and boundaries of one proposed pull request. */
export interface MaintenanceRecipe {
  readonly version: 1;
  /** SHA-256 over the branch, snapshot, files, and body. */
  readonly id: string;
  readonly proposal: string;
  readonly snapshot: string;
  readonly branch: string;
  readonly base: string;
  readonly title: string;
  readonly body: string;
  readonly commitMessage: string;
  /** Authorized files only, sorted by path. */
  readonly files: readonly string[];
  readonly labels: readonly string[];
  readonly outputs: readonly string[];
  readonly checks: readonly string[];
  readonly permissions: {
    readonly contents: "write";
    readonly pullRequests: "write";
    readonly publish: false;
    readonly merge: false;
  };
  /** True when there is nothing to propose; no branch or pull request is opened. */
  readonly noop: boolean;
}

/** One pull request already open for a branch. */
export interface MaintenanceOpenPullRequest {
  readonly number: number;
  readonly branch: string;
  readonly labels: readonly string[];
  readonly snapshot?: string;
}

/** What to do with an open pull request for the same task. */
export interface MaintenancePullRequestPlan {
  readonly action: "create" | "update" | "none";
  readonly branch: string;
  readonly number?: number;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
  readonly files: readonly string[];
  readonly noop: boolean;
}

/** Why a proposal is a no-op, or that it is not one. */
export interface MaintenanceNoop {
  readonly noop: boolean;
  readonly reason: "empty-diff" | "already-resolved" | "none";
  readonly evidence: readonly string[];
}

/** The stage that failed, for a policy-safe failure report. */
export type MaintenanceStage =
  | "trigger"
  | "task"
  | "patch"
  | "preview"
  | "verification"
  | "recipe"
  | "state";

/** One recorded failure: the stage, a stable code, and a sentence without source content. */
export interface MaintenanceFailure {
  readonly stage: MaintenanceStage;
  readonly code: string;
  readonly message: string;
}

/** The last good state a failed run keeps, so the next run can resume explicitly. */
export interface MaintenanceState {
  readonly version: 1;
  readonly task: string;
  readonly snapshot: string;
  readonly phase: "idle" | "proposed" | "verified" | "failed";
  /** The source hashes of the last good run; a failed run never replaces them. */
  readonly sources: Readonly<Record<string, string>>;
  readonly proposal?: string;
  readonly pullRequest?: { readonly branch: string; readonly number?: number };
  /** Every failure, in the order it happened. */
  readonly failures: readonly MaintenanceFailure[];
  /** A retry is never automatic. */
  readonly retry: "explicit";
}

/** A state after recording a failure, and the state that was preserved. */
export interface MaintenanceStateResult {
  readonly state: MaintenanceState;
  readonly preserved: MaintenanceState;
}

/** The scope of one task, with every derived resource and every exclusion. */
export interface MaintenanceScopeResult {
  /** The constrained scope. */
  readonly scope: TaskScope;
  /** Resources left out, with the rule that excluded each. */
  readonly excluded: readonly { readonly ref: string; readonly reason: string }[];
}
