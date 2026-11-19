/**
 * Focused clarification: an incomplete task becomes one question with choices or the field that is
 * missing, and no edit can run until the question is answered.
 *
 * The question comes from the task contract's own validation problem, in document order, so it
 * names the exact field and says what a valid value looks like. Exactly one question is open at a
 * time; the session status is `clarifying` and {@link applyInteractionEdit} refuses until
 * {@link answerClarification} records the answer.
 */
import type {
  InteractionProblem,
  InteractionQuestion,
  InteractionSession,
} from "../contracts/interaction.ts";
import { parseTaskContract, type TaskParseOptions } from "../tasks/contract.ts";
import { failed, succeeded, textOf, type InteractionResult } from "./result.ts";

/** What clarification may use besides the draft. */
export interface ClarifyInteractionOptions extends TaskParseOptions {
  /** Choices by JSON Pointer, for a field whose answer is a selection. */
  readonly choices?: Readonly<Record<string, readonly string[]>>;
}

/** Opens one question about the first problem in an incomplete task contract. */
export function clarifyInteraction(
  session: InteractionSession,
  draft: unknown,
  options: ClarifyInteractionOptions = {},
): InteractionResult {
  if (session.applied.length > 0) {
    return failed(
      "/status",
      "interaction.clarification-late",
      "The session already applied an edit, so clarification cannot precede it; register a new task for the changed request.",
    );
  }
  if (session.status !== "active" && session.status !== "clarifying") {
    return failed(
      "/status",
      "interaction.status",
      `Clarification can open only while the session is \`active\`; it is \`${session.status}\`.`,
    );
  }

  const parsed = parseTaskContract(draft, {
    ...(options.checks === undefined ? {} : { checks: options.checks }),
    ...(options.references === undefined ? {} : { references: options.references }),
  });
  if (parsed.contract !== undefined) {
    return failed(
      "/goal",
      "interaction.task-complete",
      "The task contract is complete, so there is nothing to clarify; start the work instead.",
    );
  }

  const problem = parsed.problems[0];
  if (problem === undefined) {
    return failed(
      "/",
      "interaction.task-incomplete",
      "The task is incomplete but names no field to ask about; give the contract a missing or invalid field.",
    );
  }

  const question = questionOf(problem, options.choices);
  return succeeded({ ...session, status: "clarifying", question });
}

/** Answers the one open question and returns the session to `active`. */
export function answerClarification(
  session: InteractionSession,
  answer: string,
): InteractionResult {
  if (session.status !== "clarifying" || session.question === null) {
    return failed(
      "/status",
      "interaction.status",
      `There is no open question; the session is \`${session.status}\`.`,
    );
  }
  const text = textOf(answer);
  if (text === "") {
    return failed("/answer", "interaction.empty", "An answer to the clarification question cannot be empty.");
  }

  return succeeded({
    ...session,
    status: "active",
    question: null,
    decisions: [
      ...session.decisions,
      {
        subject: session.question.field,
        choice: text,
        reason: "Answered the open clarification question.",
      },
    ],
  });
}

/** One question from one validation problem, with choices when the caller supplied them. */
function questionOf(
  problem: InteractionProblem,
  choices: Readonly<Record<string, readonly string[]>> | undefined,
): InteractionQuestion {
  const field = problem.path === "" ? "/" : problem.path;
  const selected = [...new Set((choices?.[field] ?? []).map(textOf).filter((choice) => choice !== ""))];
  return {
    field,
    question:
      selected.length > 0
        ? `Which value should \`${field}\` use?`
        : `What should \`${field}\` be?`,
    detail: problem.message,
    choices: selected,
  };
}
