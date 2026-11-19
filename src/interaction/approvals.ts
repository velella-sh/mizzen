/**
 * Scoped approval: a request names the stage, action, files, and effect; an answer covers exactly
 * that request and nothing else.
 *
 * An approval is tied to the input snapshot and the approval policy it was made under. A changed
 * snapshot or policy makes it invalid at use time, so a stale approval cannot authorize an edit to
 * files the person never saw. A request is always made in the session's current stage, and using
 * it in another stage is refused, because approving a preview is not approving an edit.
 */
import type {
  InteractionApproval,
  InteractionApprovalDecision,
  InteractionApprovalRequest,
  InteractionProblem,
  InteractionSession,
  InteractionStage,
} from "../contracts/interaction.ts";
import { failed, relativeFile, succeeded, textOf, type InteractionResult } from "./result.ts";

/** What a caller asks to do. The stage is the session's current one. */
export interface ApprovalRequestInput {
  /** Stable id, unique in the session. */
  readonly id: string;
  /** The action type, such as `edit` or `default`. */
  readonly action: string;
  /** The files the action may touch, relative to the site root with forward slashes. */
  readonly files: readonly string[];
  /** The impact criteria, in one sentence. */
  readonly effect: string;
}

/** A person's answer to a request. */
export interface ApprovalDecisionInput {
  /** The request being answered. */
  readonly requestId: string;
  /** The principal answering. */
  readonly principal: string;
  /** Allow or refuse the exact request. */
  readonly decision: InteractionApprovalDecision;
  /** Why the principal answered this way. */
  readonly reason: string;
}

/** What an approval is used for. */
export interface ApprovalScope {
  /** The stage the action runs in. */
  readonly stage: InteractionStage;
  /** The action type. */
  readonly action: string;
  /** The files the action touches; every one must be covered by the approval. */
  readonly files: readonly string[];
}

/** Whether one approval still matches the current snapshot and policy. */
export interface ApprovalValidity {
  /** True when the snapshot and policy are unchanged. */
  readonly valid: boolean;
  /** Why the approval expired when it did. */
  readonly reason?: string;
}

/** True for a stage that can hold activity; `done` only records feedback. */
function isWorkingStage(stage: InteractionStage): boolean {
  return stage !== "done";
}

/** Records an approval request for the session's current stage. */
export function requestApproval(
  session: InteractionSession,
  input: ApprovalRequestInput,
): InteractionResult {
  if (session.status !== "active") {
    return failed(
      "/status",
      "interaction.status",
      `Approval can be requested only while the session is \`active\`; it is \`${session.status}\`. ${nextStep(session.status)}`,
    );
  }
  if (!isWorkingStage(session.stage)) {
    return failed(
      "/stage",
      "interaction.stage",
      "Approval cannot be requested in `done`; start a new task for more work.",
    );
  }

  const id = textOf(input.id);
  if (id === "") return failed("/id", "interaction.empty", "An approval request needs a stable `id`.");
  if (session.approvalRequests.some((request) => request.id === id)) {
    return failed(
      "/id",
      "interaction.approval-duplicate",
      `Approval request \`${id}\` already exists; use a new id for a new scope.`,
    );
  }

  const action = textOf(input.action);
  if (action === "") return failed("/action", "interaction.empty", "An approval request needs an `action` type.");
  const effect = textOf(input.effect);
  if (effect === "") {
    return failed(
      "/effect",
      "interaction.empty",
      "An approval request needs an `effect`: the impact criteria the person is approving.",
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
        message: `\`${file}\` is not a site-relative file path with forward slashes; write a path such as \`docs/install.md\`.`,
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
      message: "An approval request must name at least one file it may touch.",
    });
  }
  if (problems.length > 0) return { problems };

  const request: InteractionApprovalRequest = {
    id,
    stage: session.stage,
    action,
    files,
    effect,
    snapshot: session.snapshot,
    policy: session.policy,
  };
  return succeeded({
    ...session,
    status: "awaiting-approval",
    approvalRequests: [...session.approvalRequests, request],
  });
}

/** Records a person's answer to a pending request. */
export function decideApproval(
  session: InteractionSession,
  input: ApprovalDecisionInput,
): InteractionResult {
  if (session.status !== "awaiting-approval") {
    return failed(
      "/status",
      "interaction.status",
      `An approval can be answered only while the session is \`awaiting-approval\`; it is \`${session.status}\`. ${nextStep(session.status)}`,
    );
  }

  const requestId = textOf(input.requestId);
  const request = session.approvalRequests.find((candidate) => candidate.id === requestId);
  if (request === undefined) {
    return failed(
      "/requestId",
      "interaction.approval-unknown",
      `No approval request \`${requestId}\` exists; request the exact stage, action, and files first.`,
    );
  }

  const principal = textOf(input.principal);
  if (principal === "") {
    return failed("/principal", "interaction.empty", "An approval answer needs a `principal`.");
  }
  const reason = textOf(input.reason);
  if (reason === "") {
    return failed("/reason", "interaction.empty", "An approval answer needs a `reason`.");
  }
  if (input.decision !== "approved" && input.decision !== "rejected") {
    return failed(
      "/decision",
      "interaction.decision",
      "An approval decision must be `approved` or `rejected`.",
    );
  }

  const approval: InteractionApproval = {
    requestId,
    stage: request.stage,
    action: request.action,
    files: request.files,
    effect: request.effect,
    snapshot: session.snapshot,
    policy: session.policy,
    principal,
    decision: input.decision,
    reason,
  };

  return succeeded({
    ...session,
    status: "active",
    approvals: [...session.approvals, approval],
    decisions: [
      ...session.decisions,
      { subject: `approval:${request.action}`, choice: input.decision, reason },
    ],
  });
}

/** Why an approval no longer applies, or `undefined` when it still does. */
export function approvalValidity(
  approval: InteractionApproval,
  snapshot: string,
  policy: string,
): ApprovalValidity {
  if (approval.snapshot !== snapshot) {
    return {
      valid: false,
      reason: `the snapshot changed from \`${approval.snapshot}\` to \`${snapshot}\``,
    };
  }
  if (approval.policy !== policy) {
    return {
      valid: false,
      reason: `the approval policy changed from \`${approval.policy}\` to \`${policy}\``,
    };
  }
  return { valid: true };
}

/** True when the session holds an approved answer for exactly this stage, action, and files. */
export function isApproved(session: InteractionSession, scope: ApprovalScope): boolean {
  return session.approvals.some(
    (approval) =>
      approval.decision === "approved" &&
      approval.stage === scope.stage &&
      approval.action === scope.action &&
      scope.files.every((file) => approval.files.includes(file)) &&
      approvalValidity(approval, session.snapshot, session.policy).valid,
  );
}

/**
 * Why the named approval cannot be used for `scope`, or `undefined` when it can. The message names
 * the exact mismatch, so the caller can request a corrected scope instead of retrying blindly.
 */
export function approvalProblem(
  session: InteractionSession,
  approvalId: string,
  scope: Omit<ApprovalScope, "files"> & { readonly files?: readonly string[] },
): InteractionProblem | undefined {
  const id = textOf(approvalId);
  if (id === "") {
    return {
      path: "/approvalId",
      code: "interaction.approval-required",
      message: `Action \`${scope.action}\` needs an approved request for stage \`${scope.stage}\`; none was named.`,
    };
  }

  const approval = session.approvals.find((candidate) => candidate.requestId === id);
  if (approval === undefined) {
    if (session.approvalRequests.some((request) => request.id === id)) {
      return {
        path: "/approvalId",
        code: "interaction.approval-pending",
        message: `Approval request \`${id}\` has no answer yet; ask the principal to answer it before using it.`,
      };
    }
    return {
      path: "/approvalId",
      code: "interaction.approval-required",
      message: `No approval \`${id}\` exists; request one for stage \`${scope.stage}\`, action \`${scope.action}\`, and the files it may touch.`,
    };
  }

  if (approval.decision === "rejected") {
    return {
      path: "/approvalId",
      code: "interaction.approval-rejected",
      message: `Approval request \`${id}\` was rejected by \`${approval.principal}\`: ${approval.reason}`,
    };
  }

  const validity = approvalValidity(approval, session.snapshot, session.policy);
  if (!validity.valid) {
    return {
      path: "/approvalId",
      code: "interaction.approval-expired",
      message: `Approval \`${id}\` expired because ${validity.reason}; request a new approval for the current inputs.`,
    };
  }

  if (approval.stage !== scope.stage) {
    return {
      path: "/approvalId",
      code: "interaction.approval-scope",
      message: `Approval \`${id}\` covers stage \`${approval.stage}\`, not \`${scope.stage}\`; an approval never carries over to another stage.`,
    };
  }
  if (approval.action !== scope.action) {
    return {
      path: "/approvalId",
      code: "interaction.approval-scope",
      message: `Approval \`${id}\` covers action \`${approval.action}\`, not \`${scope.action}\`; request the action you need.`,
    };
  }

  const files = scope.files ?? [];
  const uncovered = files.filter((file) => !approval.files.includes(file));
  if (uncovered.length > 0) {
    return {
      path: "/approvalId",
      code: "interaction.approval-scope",
      message: `Approval \`${id}\` does not cover ${uncovered.map((file) => `\`${file}\``).join(", ")}; request an approval that names every file.`,
    };
  }

  return undefined;
}

/** What the session needs before it can act, by status. */
function nextStep(status: InteractionSession["status"]): string {
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
