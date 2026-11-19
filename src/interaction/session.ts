/**
 * The interaction session: start a task, advance its stage, record an explained refusal, apply one
 * approved edit, and finish with exactly one result.
 *
 * The session is one JSON document. Every function takes it and returns a new one, so a consumer
 * can persist it between calls and another consumer can pick it up. Two rules are enforced here:
 * an edit needs an approval for the stage, action, and files it touches, and a repeated edit id is
 * refused, so resuming never writes the same edit twice.
 */
import type {
  InteractionCheckpoint,
  InteractionProblem,
  InteractionRefusalSource,
  InteractionSession,
  InteractionStage,
} from "../contracts/interaction.ts";
import { approvalProblem } from "./approvals.ts";
import {
  failed,
  isHash,
  relativeFile,
  succeeded,
  textOf,
  type InteractionResult,
} from "./result.ts";

/** The only interaction-session version. */
export const INTERACTION_DOCUMENT_VERSION = 1;

/** Every stage, in the order a task moves through them. */
export const INTERACTION_STAGES = ["context", "preview", "edit", "verify", "done"] as const;

/** Every status a session can hold. */
export const INTERACTION_STATUSES = [
  "active",
  "clarifying",
  "awaiting-approval",
  "paused",
  "refused",
  "handed-off",
  "done",
] as const;

/** The stages a checkpoint may be taken in: after context compilation or a preview. */
export const PAUSE_STAGES = ["context", "preview"] as const;

/** What {@link startInteraction} needs. */
export interface StartInteractionInput {
  /** The task id, a 64-character SHA-256 digest. */
  readonly taskId: string;
  /** The input snapshot id, a 64-character SHA-256 digest. */
  readonly snapshot: string;
  /** The approval policy the work runs under, such as `policy-v1`. */
  readonly policy: string;
  /** The task goal, in one sentence. */
  readonly goal: string;
}

/** Moves a session forward one or more stages. */
export interface AdvanceInteractionInput {
  /** The stage to enter; it must be later than the current stage. */
  readonly stage: InteractionStage;
  /** Why the stage moves, in one sentence. */
  readonly reason: string;
}

/** Records the single final result. */
export interface FinishInteractionInput {
  /** The result reference, such as a proof or report id. */
  readonly result: string;
}

/** Explains one refusal. */
export interface RefuseInteractionInput {
  /** `permission`, `context`, or `check`. */
  readonly source: InteractionRefusalSource;
  /** Stable reason code. */
  readonly code: string;
  /** What happened, in one sentence. */
  readonly detail: string;
  /** The recovery action that lets the task continue. */
  readonly action: string;
  /** Evidence for the refusal, such as a failed check id. */
  readonly evidence?: string;
}

/** Recovers a refused session after its recovery action. */
export interface RecoverInteractionInput {
  /** What was done to recover, in one sentence. */
  readonly reason: string;
}

/** Applies one edit under an approval. */
export interface ApplyInteractionEditInput {
  /** Stable edit id; a repeated id is refused, not applied twice. */
  readonly id: string;
  /** The files the edit touches, relative to the site root with forward slashes. */
  readonly files: readonly string[];
  /** The approved request that covers this stage, action, and every file. */
  readonly approvalId: string;
}

/** Starts one interaction in `context`. */
export function startInteraction(input: StartInteractionInput): InteractionResult {
  const taskId = textOf(input.taskId);
  if (!isHash(taskId)) {
    return failed(
      "/taskId",
      "interaction.task-id",
      "`taskId` must be a 64-character lowercase SHA-256 digest; register the task first.",
    );
  }
  const snapshot = textOf(input.snapshot);
  if (!isHash(snapshot)) {
    return failed(
      "/snapshot",
      "interaction.snapshot",
      "`snapshot` must be a 64-character lowercase SHA-256 digest; use the task's snapshot id.",
    );
  }
  const policy = textOf(input.policy);
  if (policy === "" || policy.length > 200) {
    return failed(
      "/policy",
      "interaction.policy",
      "`policy` must name the approval policy in 1 to 200 characters.",
    );
  }
  const goal = textOf(input.goal);
  if (goal === "" || goal.length > 1000) {
    return failed(
      "/goal",
      "interaction.goal",
      "`goal` must describe the task in 1 to 1000 characters.",
    );
  }

  const session: InteractionSession = {
    version: INTERACTION_DOCUMENT_VERSION,
    taskId,
    snapshot,
    policy,
    goal,
    stage: "context",
    status: "active",
    question: null,
    decisions: [],
    approvalRequests: [],
    approvals: [],
    refusal: null,
    checkpoint: null,
    handoff: null,
    feedback: [],
    applied: [],
    resumedBy: [],
    resumeReason: null,
    result: null,
  };
  return succeeded(session);
}

/** Moves the session forward, never back, and never straight to `done`. */
export function advanceInteraction(
  session: InteractionSession,
  input: AdvanceInteractionInput,
): InteractionResult {
  if (session.status !== "active") {
    return failed(
      "/status",
      "interaction.status",
      `The stage can advance only while the session is \`active\`; it is \`${session.status}\`. ${stepOf(session.status)}`,
    );
  }
  if (input.stage === "done") {
    return failed(
      "/stage",
      "interaction.stage",
      "`done` is entered by finishing the task with a result, not by advancing the stage.",
    );
  }
  const current = INTERACTION_STAGES.indexOf(session.stage);
  const next = INTERACTION_STAGES.indexOf(input.stage);
  if (next <= current) {
    return failed(
      "/stage",
      "interaction.stage",
      `The session is in \`${session.stage}\`; the next stage must be later than it, such as \`${INTERACTION_STAGES[current + 1] ?? "verify"}\`.`,
    );
  }
  const reason = textOf(input.reason);
  if (reason === "") {
    return failed("/reason", "interaction.empty", "Advancing the stage needs a non-empty reason.");
  }

  return succeeded({ ...session, stage: input.stage });
}

/** Records the one final result. Repeating the same result is idempotent; a different one is refused. */
export function finishInteraction(
  session: InteractionSession,
  input: FinishInteractionInput,
): InteractionResult {
  const result = textOf(input.result);
  if (result === "") {
    return failed("/result", "interaction.empty", "Finishing a task needs a non-empty result reference.");
  }

  if (session.status === "done") {
    if (session.result === result) return succeeded(session);
    return failed(
      "/result",
      "interaction.result-conflict",
      `The task already finished with result \`${session.result ?? ""}\`; it cannot also finish with \`${result}\`.`,
    );
  }
  if (session.status !== "active" || session.stage !== "verify") {
    return failed(
      "/stage",
      "interaction.finish-stage",
      `A task finishes from \`active\` in \`verify\`; it is \`${session.status}\` in \`${session.stage}\`. ${stepOf(session.status)}`,
    );
  }

  return succeeded({ ...session, status: "done", stage: "done", result });
}

/** Records one refusal with its source, reason code, detail, and required action. */
export function refuseInteraction(
  session: InteractionSession,
  input: RefuseInteractionInput,
): InteractionResult {
  if (session.status === "done") {
    return failed(
      "/status",
      "interaction.status",
      "A finished task cannot record a new refusal; record feedback instead.",
    );
  }
  if (
    input.source !== "permission" &&
    input.source !== "context" &&
    input.source !== "check"
  ) {
    return failed(
      "/source",
      "interaction.refusal-source",
      "A refusal source must be `permission`, `context`, or `check`.",
    );
  }
  const code = textOf(input.code);
  if (code === "") {
    return failed(
      "/code",
      "interaction.empty",
      "A refusal needs a stable reason `code` so it is never an unexplained failure.",
    );
  }
  const detail = textOf(input.detail);
  if (detail === "") {
    return failed("/detail", "interaction.empty", "A refusal needs a `detail` sentence.");
  }
  const action = textOf(input.action);
  if (action === "") {
    return failed(
      "/action",
      "interaction.empty",
      "A refusal needs the `action` that recovers from it; a refusal without a next step is unexplained.",
    );
  }
  const evidence = textOf(input.evidence);

  return succeeded({
    ...session,
    status: "refused",
    refusal: {
      source: input.source,
      code,
      detail,
      action,
      evidence: evidence === "" ? null : evidence,
    },
  });
}

/** Returns a refused session to `active` after its recovery action, keeping the refusal for audit. */
export function recoverInteraction(
  session: InteractionSession,
  input: RecoverInteractionInput,
): InteractionResult {
  if (session.status !== "refused" || session.refusal === null) {
    return failed(
      "/status",
      "interaction.status",
      `Only a refused session can recover; it is \`${session.status}\` with ${session.refusal === null ? "no refusal" : "a refusal"}.`,
    );
  }
  const reason = textOf(input.reason);
  if (reason === "") {
    return failed("/reason", "interaction.empty", "Recovering from a refusal needs a non-empty reason.");
  }

  return succeeded({
    ...session,
    status: "active",
    decisions: [
      ...session.decisions,
      { subject: "refusal", choice: session.refusal.code, reason },
    ],
  });
}

/** Applies one edit whose scope is covered by an approved request for the `edit` stage. */
export function applyInteractionEdit(
  session: InteractionSession,
  input: ApplyInteractionEditInput,
): InteractionResult {
  const id = textOf(input.id);
  if (id === "") return failed("/id", "interaction.empty", "An edit needs a stable `id`.");

  if (session.applied.includes(id)) {
    return failed(
      "/id",
      "interaction.edit-repeated",
      `Edit \`${id}\` was already applied; resuming must not repeat it.`,
    );
  }
  if (session.status !== "active") {
    return failed(
      "/status",
      "interaction.status",
      `An edit can be applied only while the session is \`active\`; it is \`${session.status}\`. ${stepOf(session.status)}`,
    );
  }
  if (session.stage !== "edit") {
    return failed(
      "/stage",
      "interaction.edit-stage",
      `An edit runs in the \`edit\` stage; the session is in \`${session.stage}\`.`,
    );
  }

  const files: string[] = [];
  const problems: InteractionProblem[] = [];
  input.files.forEach((raw, index) => {
    const file = textOf(raw);
    if (!relativeFile(file)) {
      problems.push({
        path: `/files/${index}`,
        code: "interaction.file",
        message: `\`${file}\` is not a site-relative file path with forward slashes.`,
      });
    } else if (files.includes(file)) {
      problems.push({
        path: `/files/${index}`,
        code: "interaction.duplicate",
        message: `\`${file}\` repeats an earlier file; remove the duplicate.`,
      });
    } else {
      files.push(file);
    }
  });
  if (input.files.length === 0) {
    problems.push({
      path: "/files",
      code: "interaction.empty",
      message: "An edit must name at least one file it touches.",
    });
  }
  if (problems.length > 0) return { problems };

  const approval = approvalProblem(session, input.approvalId, {
    stage: "edit",
    action: "edit",
    files,
  });
  if (approval !== undefined) return { problems: [approval] };

  return succeeded({ ...session, applied: [...session.applied, id] });
}

/** What a session needs before it can act, by status. */
function stepOf(status: InteractionSession["status"]): string {
  switch (status) {
    case "clarifying":
      return "Answer the open question first.";
    case "awaiting-approval":
      return "Answer the pending approval first.";
    case "paused":
      return "Resume from the checkpoint first.";
    case "refused":
      return "Recover from the refusal first.";
    case "handed-off":
      return "Resume from the handoff in the next consumer.";
    case "done":
      return "The task is finished.";
    default:
      return "";
  }
}

/** The checkpoint fields a resume compares; exported for the checkpoint module's messages. */
export function checkpointMatches(
  checkpoint: InteractionCheckpoint,
  session: InteractionSession,
): readonly InteractionProblem[] {
  const problems: InteractionProblem[] = [];
  if (checkpoint.taskId !== session.taskId) {
    problems.push({
      path: "/checkpoint/taskId",
      code: "interaction.checkpoint-task",
      message: `The checkpoint belongs to task \`${checkpoint.taskId}\`, not \`${session.taskId}\`.`,
    });
  }
  if (checkpoint.snapshot !== session.snapshot) {
    problems.push({
      path: "/checkpoint/snapshot",
      code: "interaction.checkpoint-expired",
      message: `The checkpoint was taken against snapshot \`${checkpoint.snapshot}\`, but the session now runs against \`${session.snapshot}\`; recompile the context.`,
    });
  }
  if (checkpoint.policy !== session.policy) {
    problems.push({
      path: "/checkpoint/policy",
      code: "interaction.checkpoint-expired",
      message: `The checkpoint was taken under policy \`${checkpoint.policy}\`, but the session now uses \`${session.policy}\`; resume with a recorded reason.`,
    });
  }
  if (
    checkpoint.applied.length !== session.applied.length ||
    checkpoint.applied.some((id, index) => id !== session.applied[index])
  ) {
    problems.push({
      path: "/checkpoint/applied",
      code: "interaction.checkpoint-stale",
      message: `The checkpoint records ${checkpoint.applied.length} applied edit(s), but the session has ${session.applied.length}; resuming it would repeat an edit.`,
    });
  }
  return problems;
}
