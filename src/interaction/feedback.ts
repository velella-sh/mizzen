/**
 * Feedback on a task result: accepted, rejected, or corrected, always linked to the task and the
 * evidence it judges.
 *
 * The record copies only the public fields a human wrote. It holds no prompt, model, or
 * conversation data, so the feedback can live beside the task document without exposing how the
 * result was produced.
 */
import type {
  InteractionCorrection,
  InteractionFeedback,
  InteractionFeedbackOutcome,
  InteractionProblem,
  InteractionSession,
} from "../contracts/interaction.ts";
import { failed, succeeded, textOf, type InteractionResult } from "./result.ts";

/** What a person says about one result. */
export interface FeedbackInput {
  /** Accepted, rejected, or corrected. */
  readonly outcome: InteractionFeedbackOutcome;
  /** The result or evidence reference the feedback judges. */
  readonly evidence: string;
  /** The principal that gave the feedback. */
  readonly principal: string;
  /** Why, in the person's words. */
  readonly note?: string;
  /** The corrections; required when `outcome` is `modified`. */
  readonly corrections?: readonly InteractionCorrection[];
}

/** Records one human judgement, linked to the session's task and the named evidence. */
export function recordFeedback(
  session: InteractionSession,
  input: FeedbackInput,
): InteractionResult {
  if (input.outcome !== "accepted" && input.outcome !== "rejected" && input.outcome !== "modified") {
    return failed(
      "/outcome",
      "interaction.feedback-outcome",
      "Feedback must be `accepted`, `rejected`, or `modified`.",
    );
  }
  const evidence = textOf(input.evidence);
  if (evidence === "") {
    return failed(
      "/evidence",
      "interaction.empty",
      "Feedback needs the `evidence` it judges, such as the result or a check id.",
    );
  }
  const principal = textOf(input.principal);
  if (principal === "") {
    return failed("/principal", "interaction.empty", "Feedback needs the `principal` that gave it.");
  }

  const problems: InteractionProblem[] = [];
  const note = textOf(input.note);
  if (input.note !== undefined && note === "") {
    problems.push({
      path: "/note",
      code: "interaction.empty",
      message: "A feedback note cannot be empty; omit it instead.",
    });
  }

  const corrections = (input.corrections ?? []).map((correction, index) => {
    const field = textOf(correction.field);
    const value = textOf(correction.value);
    const reason = textOf(correction.reason);
    if (field === "") {
      problems.push({
        path: `/corrections/${index}/field`,
        code: "interaction.empty",
        message: "A correction needs the `field` it changes.",
      });
    }
    if (value === "") {
      problems.push({
        path: `/corrections/${index}/value`,
        code: "interaction.empty",
        message: "A correction needs its new `value`.",
      });
    }
    if (reason === "") {
      problems.push({
        path: `/corrections/${index}/reason`,
        code: "interaction.empty",
        message: "A correction needs the `reason` it applies.",
      });
    }
    return { field, value, reason };
  });

  if (input.outcome === "modified" && corrections.length === 0) {
    problems.push({
      path: "/corrections",
      code: "interaction.corrections",
      message: "`modified` feedback must name at least one correction.",
    });
  }
  if (problems.length > 0) return { problems };

  const feedback: InteractionFeedback = {
    outcome: input.outcome,
    taskId: session.taskId,
    evidence,
    principal,
    ...(note === "" ? {} : { note }),
    ...(corrections.length === 0 ? {} : { corrections }),
  };

  return succeeded({ ...session, feedback: [...session.feedback, feedback] });
}
