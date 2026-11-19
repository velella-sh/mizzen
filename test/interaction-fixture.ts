import assert from "node:assert/strict";
import type {
  InteractionApprovalDecision,
  InteractionSession,
  InteractionStage,
} from "../src/contracts/index.ts";
import {
  advanceInteraction,
  applyInteractionEdit,
  decideApproval,
  requestApproval,
  startInteraction,
  type InteractionResult,
} from "../src/interaction/index.ts";

/** A task id that satisfies the hash rule. */
export const TASK_ID = "a".repeat(64);
/** The snapshot every fixture session starts against. */
export const SNAPSHOT = "b".repeat(64);
/** A different snapshot, for expiry checks. */
export const CHANGED_SNAPSHOT = "c".repeat(64);
/** The approval policy every fixture session starts under. */
export const POLICY = "policy-v1";
/** The file the fixture edit touches. */
export const EDIT_FILE = "docs/install.md";

/** Starts a session that must be valid, with the fields a test overrides. */
export function started(
  input: { readonly taskId?: string; readonly snapshot?: string; readonly policy?: string; readonly goal?: string } = {},
): InteractionSession {
  return ok(
    startInteraction({
      taskId: input.taskId ?? TASK_ID,
      snapshot: input.snapshot ?? SNAPSHOT,
      policy: input.policy ?? POLICY,
      goal: input.goal ?? "Update the install guide",
    }),
  );
}

/** Returns the session of a result that must succeed. */
export function ok(result: InteractionResult): InteractionSession {
  assert.deepEqual(result.problems, [], result.problems.map((problem) => problem.message).join("; "));
  assert.ok(result.session, "a successful interaction has a session");
  return result.session;
}

/** Returns the problems of a result that must be refused. */
export function refused(result: InteractionResult) {
  assert.equal(result.session, undefined);
  assert.ok(result.problems.length > 0, "a refused interaction has problems");
  return result.problems;
}

/** Moves a session straight to a later stage. */
export function atStage(session: InteractionSession, stage: InteractionStage): InteractionSession {
  if (session.stage === stage) return session;
  return ok(advanceInteraction(session, { stage, reason: `Advanced to ${stage}.` }));
}

/** Requests and answers one approval in the session's current stage. */
export function approved(
  session: InteractionSession,
  input: {
    readonly id: string;
    readonly action: string;
    readonly files: readonly string[];
    readonly effect?: string;
    readonly principal?: string;
    readonly decision?: InteractionApprovalDecision;
  },
): InteractionSession {
  const requested = ok(
    requestApproval(session, {
      id: input.id,
      action: input.action,
      files: input.files,
      effect: input.effect ?? "Only the named files change.",
    }),
  );
  return ok(
    decideApproval(requested, {
      requestId: input.id,
      principal: input.principal ?? "human",
      decision: input.decision ?? "approved",
      reason: "The scope is reviewable.",
    }),
  );
}

/** A session in `edit` with an approved edit request. */
export function editReady(): { readonly session: InteractionSession; readonly approvalId: string } {
  const approvalId = "approve-edit";
  const session = approved(atStage(started(), "edit"), {
    id: approvalId,
    action: "edit",
    files: [EDIT_FILE],
  });
  return { session, approvalId };
}

/** A session that applied one edit and moved to `verify`. */
export function verifyReady(): InteractionSession {
  const { session, approvalId } = editReady();
  const edited = ok(
    applyInteractionEdit(session, { id: "edit-1", files: [EDIT_FILE], approvalId }),
  );
  return atStage(edited, "verify");
}
