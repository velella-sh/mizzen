/**
 * Human and agent interaction for one task: questions, approvals, refusals, checkpoints,
 * handoffs, and feedback.
 *
 * A task can be ambiguous, can need a person's permission, can be refused for a reason the caller
 * must fix, and can pause and continue in another process. This module is the public shape of that
 * conversation. It holds no model conversation: a question, a decision, a refusal, a checkpoint,
 * and a handoff each name the task, the input snapshot, and the evidence that makes them
 * actionable. The pure functions in `../interaction/` produce these values; nothing here reads a
 * file, calls a model, or reads a clock.
 */

/** Where a task is in the interaction: context, preview, edit, verify, or done. */
export type InteractionStage = "context" | "preview" | "edit" | "verify" | "done";

/**
 * What a session is waiting for. `active` may record decisions and edits; the others name exactly
 * the action that moves it forward.
 */
export type InteractionStatus =
  | "active"
  | "clarifying"
  | "awaiting-approval"
  | "paused"
  | "refused"
  | "handed-off"
  | "done";

/** One specific question about one field, with choices when the answer is a selection. */
export interface InteractionQuestion {
  /** JSON Pointer to the field the answer fills, such as `/scope/pages`. */
  readonly field: string;
  /** The one question, ending in a question mark. */
  readonly question: string;
  /** Why the question is needed, copied from the validation problem. */
  readonly detail: string;
  /** Acceptable answers, in caller order; empty when the answer is a field value. */
  readonly choices: readonly string[];
}

/** One decision already made, with the reason it applies. */
export interface InteractionDecision {
  /** What the decision is about, such as a field or an approval action. */
  readonly subject: string;
  /** What was chosen. */
  readonly choice: string;
  /** Why it applies. */
  readonly reason: string;
}

/** A request for permission to do one action on one set of files at one stage. */
export interface InteractionApprovalRequest {
  /** Stable caller id, unique in the session. */
  readonly id: string;
  /** The stage the request was made in; an approval never covers another stage. */
  readonly stage: InteractionStage;
  /** The action type, such as `edit` or `default`. */
  readonly action: string;
  /** The files the action may touch, relative to the site root with forward slashes. */
  readonly files: readonly string[];
  /** The impact criteria a person is approving, in one sentence. */
  readonly effect: string;
  /** The input snapshot the request was made against. */
  readonly snapshot: string;
  /** The approval policy the request was made under. */
  readonly policy: string;
}

/** A person's answer to one approval request. */
export interface InteractionApproval {
  /** The request this answer belongs to. */
  readonly requestId: string;
  /** The stage copied from the request. */
  readonly stage: InteractionStage;
  /** The action copied from the request. */
  readonly action: string;
  /** The files copied from the request. */
  readonly files: readonly string[];
  /** The effect copied from the request. */
  readonly effect: string;
  /** The input snapshot the answer was made against. */
  readonly snapshot: string;
  /** The approval policy the answer was made under. */
  readonly policy: string;
  /** The principal that answered. */
  readonly principal: string;
  /** Whether the action may proceed. */
  readonly decision: InteractionApprovalDecision;
  /** Why the principal answered this way. */
  readonly reason: string;
}

/** A principal's answer: allow the exact request, or refuse it. */
export type InteractionApprovalDecision = "approved" | "rejected";

/** Where a refusal came from. */
export type InteractionRefusalSource = "permission" | "context" | "check";

/** One explained refusal: what failed, where it came from, and what the caller must do. */
export interface InteractionRefusal {
  /** `permission`, `context`, or `check`; every refusal names its source. */
  readonly source: InteractionRefusalSource;
  /** Stable reason code, such as `interaction.permission-denied`; never reused for another meaning. */
  readonly code: string;
  /** What happened, in one sentence. */
  readonly detail: string;
  /** The recovery action that lets the task continue. */
  readonly action: string;
  /** Evidence for the refusal, such as a failed check id, or `null` when none. */
  readonly evidence: string | null;
}

/** A valid place to continue from, taken after context compilation or a preview. */
export interface InteractionCheckpoint {
  /** The task the checkpoint belongs to. */
  readonly taskId: string;
  /** The input snapshot the checkpoint was taken against. */
  readonly snapshot: string;
  /** The approval policy the checkpoint was taken under. */
  readonly policy: string;
  /** The stage the pause happened in: `context` or `preview`. */
  readonly stage: InteractionStage;
  /** A reference to the compiled context or preview, such as a pack or diff hash. */
  readonly evidence: string;
  /** The next action a resuming consumer should take. */
  readonly next: string;
  /** Edit ids already applied when the checkpoint was taken. */
  readonly applied: readonly string[];
}

/** One check result included in a handoff. */
export interface InteractionCheck {
  /** The check id. */
  readonly id: string;
  /** How it ended. */
  readonly status: "passed" | "failed" | "skipped";
  /** An optional evidence reference, such as a proof or report path. */
  readonly evidence?: string;
}

/** Who receives the work. */
export type InteractionHandoffTarget = "human" | "agent";

/** A public handoff: decisions, diff, checks, open questions, and the next action. */
export interface InteractionHandoff {
  /** The handoff version, always `1`. */
  readonly version: 1;
  /** Whether a person or another agent continues. */
  readonly to: InteractionHandoffTarget;
  /** The task the handoff belongs to. */
  readonly taskId: string;
  /** The input snapshot the work was done against. */
  readonly snapshot: string;
  /** The approval policy the work was done under. */
  readonly policy: string;
  /** The task goal, in one sentence. */
  readonly goal: string;
  /** Decisions already made, in session order. */
  readonly decisions: readonly InteractionDecision[];
  /** The unified diff or the reference to it. Empty when no files changed. */
  readonly diff: string;
  /** Checks that ran, in caller order. */
  readonly checks: readonly InteractionCheck[];
  /** Questions the next consumer must answer. */
  readonly questions: readonly InteractionQuestion[];
  /** The one action the next consumer should take first. */
  readonly nextAction: string;
  /** Edit ids already applied, so no consumer repeats one. */
  readonly applied: readonly string[];
  /** The final result when the work is done, or `null` while it is not. */
  readonly result: string | null;
}

/** How a human judged a task result. */
export type InteractionFeedbackOutcome = "accepted" | "rejected" | "modified";

/** One correction a person made to a result. */
export interface InteractionCorrection {
  /** The field or artifact that was corrected. */
  readonly field: string;
  /** What it should say instead. */
  readonly value: string;
  /** Why the correction applies. */
  readonly reason: string;
}

/**
 * A person's feedback on one result. It names the task and the evidence, so the judgement is
 * actionable without the conversation it came from.
 */
export interface InteractionFeedback {
  /** Accepted, rejected, or corrected. */
  readonly outcome: InteractionFeedbackOutcome;
  /** The task the feedback belongs to. */
  readonly taskId: string;
  /** The result or evidence reference the feedback judges. */
  readonly evidence: string;
  /** The principal that gave the feedback. */
  readonly principal: string;
  /** Why, in the person's words. */
  readonly note?: string;
  /** The corrections, present when `outcome` is `modified`. */
  readonly corrections?: readonly InteractionCorrection[];
}

/**
 * One task's interaction state: where it is, what it is waiting for, and every decision, approval,
 * refusal, checkpoint, handoff, and feedback recorded so far.
 */
export interface InteractionSession {
  /** The session version, always `1`. */
  readonly version: 1;
  /** The task the session belongs to. */
  readonly taskId: string;
  /** The input snapshot the session runs against. */
  readonly snapshot: string;
  /** The approval policy the session runs under. */
  readonly policy: string;
  /** The task goal, in one sentence. */
  readonly goal: string;
  /** The current stage. */
  readonly stage: InteractionStage;
  /** What the session is waiting for. */
  readonly status: InteractionStatus;
  /** The one open question while clarifying, or `null`. */
  readonly question: InteractionQuestion | null;
  /** Decisions made so far, in order. */
  readonly decisions: readonly InteractionDecision[];
  /** Approval requests, including answered ones, in order. */
  readonly approvalRequests: readonly InteractionApprovalRequest[];
  /** Approval answers, in order. */
  readonly approvals: readonly InteractionApproval[];
  /** The latest unexplained-free refusal, or `null` once none is current. */
  readonly refusal: InteractionRefusal | null;
  /** The latest checkpoint, or `null`. */
  readonly checkpoint: InteractionCheckpoint | null;
  /** The handoff produced from this session, or `null`. */
  readonly handoff: InteractionHandoff | null;
  /** Feedback recorded so far, in order. */
  readonly feedback: readonly InteractionFeedback[];
  /** Edit ids applied so far, in order. */
  readonly applied: readonly string[];
  /** Consumers that resumed this session, in order. */
  readonly resumedBy: readonly string[];
  /** Why an expired handoff or checkpoint was resumed; `null` for a normal resume. */
  readonly resumeReason: string | null;
  /** The single final result reference, or `null` while the task is unfinished. */
  readonly result: string | null;
}

/** One reason an interaction request was refused. */
export interface InteractionProblem {
  /** JSON Pointer to the offending value; `""` is the whole document. */
  readonly path: string;
  /** Stable identifier, such as `interaction.approval-scope`. */
  readonly code: string;
  /** What is wrong and what to do instead, in one sentence. */
  readonly message: string;
}
