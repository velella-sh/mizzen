/**
 * Resumable pauses: a checkpoint after context compilation or a preview, and a resume that refuses
 * to repeat an edit.
 *
 * The checkpoint records the task, snapshot, policy, stage, the evidence a consumer needs, the next
 * action, and every edit id already applied. A resume compares all of them with the session. A
 * stale checkpoint, whose applied list is shorter than the session's, is refused because resuming
 * it would replay an edit that already happened.
 */
import type {
  InteractionCheckpoint,
  InteractionSession,
} from "../contracts/interaction.ts";
import { failed, succeeded, textOf, type InteractionResult } from "./result.ts";
import { checkpointMatches, PAUSE_STAGES } from "./session.ts";

/** What a pause records. */
export interface PauseInteractionInput {
  /** A reference to the compiled context or preview, such as a pack or diff hash. */
  readonly evidence: string;
  /** The next action a resuming consumer should take. */
  readonly next: string;
}

/** What a resume needs. */
export interface ResumeInteractionInput {
  /** The checkpoint the consumer holds; defaults to the session's latest one. */
  readonly checkpoint?: InteractionCheckpoint;
  /** The consumer resuming, such as `cli` or `mcp`. */
  readonly consumer: string;
}

/** Pauses after context compilation or a preview and records a valid checkpoint. */
export function pauseInteraction(
  session: InteractionSession,
  input: PauseInteractionInput,
): InteractionResult {
  if (session.status !== "active") {
    return failed(
      "/status",
      "interaction.status",
      `A task can pause only while it is \`active\`; it is \`${session.status}\`.`,
    );
  }
  if (!(PAUSE_STAGES as readonly string[]).includes(session.stage)) {
    return failed(
      "/stage",
      "interaction.pause-stage",
      `A checkpoint is taken after \`context\` or \`preview\`; the session is in \`${session.stage}\`.`,
    );
  }

  const evidence = textOf(input.evidence);
  if (evidence === "") {
    return failed(
      "/evidence",
      "interaction.empty",
      "A checkpoint needs the context or preview evidence it continues from.",
    );
  }
  const next = textOf(input.next);
  if (next === "") {
    return failed("/next", "interaction.empty", "A checkpoint needs the next action to take.");
  }

  const checkpoint: InteractionCheckpoint = {
    taskId: session.taskId,
    snapshot: session.snapshot,
    policy: session.policy,
    stage: session.stage,
    evidence,
    next,
    applied: [...session.applied],
  };

  return succeeded({ ...session, status: "paused", checkpoint });
}

/** Resumes a paused session from one checkpoint, without repeating an earlier edit. */
export function resumeInteraction(
  session: InteractionSession,
  input: ResumeInteractionInput,
): InteractionResult {
  if (session.status !== "paused" || session.checkpoint === null) {
    return failed(
      "/status",
      "interaction.status",
      `A task resumes only while it is \`paused\`; it is \`${session.status}\`.`,
    );
  }

  const checkpoint = input.checkpoint ?? session.checkpoint;
  const problems = [...checkpointMatches(checkpoint, session)];
  if (!(PAUSE_STAGES as readonly string[]).includes(checkpoint.stage)) {
    problems.push({
      path: "/checkpoint/stage",
      code: "interaction.checkpoint-stage",
      message: `A checkpoint stage must be \`context\` or \`preview\`; it is \`${checkpoint.stage}\`.`,
    });
  } else if (checkpoint.stage !== session.checkpoint.stage) {
    problems.push({
      path: "/checkpoint/stage",
      code: "interaction.checkpoint-stage",
      message: `The checkpoint was taken in \`${checkpoint.stage}\`, but the session paused in \`${session.checkpoint.stage}\`.`,
    });
  }
  if (textOf(checkpoint.evidence) === "" || textOf(checkpoint.next) === "") {
    problems.push({
      path: "/checkpoint",
      code: "interaction.checkpoint-invalid",
      message: "A checkpoint needs both its evidence and the next action.",
    });
  }

  const consumer = textOf(input.consumer);
  if (consumer === "") {
    return failed("/consumer", "interaction.empty", "A resume needs a non-empty `consumer`.");
  }
  if (problems.length > 0) return { problems };

  return succeeded({
    ...session,
    status: "active",
    resumedBy: [...session.resumedBy, consumer],
  });
}
