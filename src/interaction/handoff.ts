/**
 * Handoffs: a public document a person or another agent can continue from.
 *
 * A handoff holds the decisions made, the diff, the checks, the open questions, the next action,
 * the applied edit ids, and the result when there is one. It holds no conversation: the builder
 * copies named fields, and the reader refuses any other key, so a model prompt or transcript cannot
 * enter the public document by accident. A fresh agent reads the document plus the current public
 * snapshot; a changed snapshot or approval policy expires the handoff, and resuming one then needs
 * a recorded reason.
 */
import type {
  InteractionCheck,
  InteractionDecision,
  InteractionHandoff,
  InteractionHandoffTarget,
  InteractionProblem,
  InteractionQuestion,
  InteractionSession,
  InteractionStage,
} from "../contracts/interaction.ts";
import { failed, isHash, succeeded, textOf, type InteractionResult } from "./result.ts";
import { INTERACTION_DOCUMENT_VERSION, INTERACTION_STAGES } from "./session.ts";

/** What a caller hands off. */
export interface HandoffInteractionInput {
  /** Whether a person or another agent continues. */
  readonly to: InteractionHandoffTarget;
  /** The unified diff, or a reference to it; empty when no file changed. */
  readonly diff: string;
  /** The checks that ran. */
  readonly checks: readonly InteractionCheck[];
  /** Questions the next consumer must answer, in addition to a pending clarification. */
  readonly questions?: readonly InteractionQuestion[];
  /** The one action the next consumer should take first. */
  readonly nextAction: string;
}

/** Where a fresh consumer resumes a handoff. */
export interface ResumeHandoffInput {
  /** The current public snapshot id. */
  readonly snapshot: string;
  /** The current approval policy. */
  readonly policy: string;
  /** The consumer resuming, such as `cli` or `mcp`. */
  readonly consumer: string;
  /** The stage to resume in; default `edit`. Ignored when the handoff carries a result. */
  readonly stage?: InteractionStage;
  /** Why an expired handoff is still safe to resume. Required only when it expired. */
  readonly reason?: string;
}

/** The result of resuming a handoff. */
export interface ResumeHandoffResult extends InteractionResult {
  /** True when the snapshot or policy had changed. */
  readonly expired: boolean;
}

/** Whether a handoff still matches the current snapshot and policy. */
export interface HandoffValidity {
  readonly valid: boolean;
  readonly reason?: string;
}

/** The exact keys a public handoff may hold, and nothing else. */
const HANDOFF_KEYS = [
  "version",
  "to",
  "taskId",
  "snapshot",
  "policy",
  "goal",
  "decisions",
  "diff",
  "checks",
  "questions",
  "nextAction",
  "applied",
  "result",
] as const;

/** The keys one decision may hold. */
const DECISION_KEYS = ["subject", "choice", "reason"] as const;

/** The keys one check may hold. */
const CHECK_KEYS = ["id", "status", "evidence"] as const;

/** The keys one question may hold. */
const QUESTION_KEYS = ["field", "question", "detail", "choices"] as const;

/** Builds the public handoff from a session's recorded evidence. */
export function handOffInteraction(
  session: InteractionSession,
  input: HandoffInteractionInput,
): InteractionResult {
  if (session.handoff !== null) {
    return failed(
      "/handoff",
      "interaction.handoff-exists",
      "The session already produced a handoff; resume it and hand off again from the new session.",
    );
  }
  if (input.to !== "human" && input.to !== "agent") {
    return failed("/to", "interaction.handoff-target", "A handoff target must be `human` or `agent`.");
  }

  const nextAction = textOf(input.nextAction);
  if (nextAction === "") {
    return failed("/nextAction", "interaction.empty", "A handoff needs the next action to take.");
  }
  if (typeof input.diff !== "string") {
    return failed("/diff", "interaction.diff", "A handoff `diff` must be a string; use \"\" for no changes.");
  }

  const problems: InteractionProblem[] = [];
  const checks = input.checks.map((check, index) =>
    checkOf(check as unknown, `/checks/${index}`, problems),
  );
  if (problems.length > 0) return { problems };

  const questions = [...(input.questions ?? [])].map((question, index) =>
    questionOf(question as unknown, `/questions/${index}`, problems),
  );
  if (problems.length > 0) return { problems };

  const pending = session.question;
  const open = pending === null
    ? questions
    : [pending, ...questions.filter((question) => question.field !== pending.field)];

  const handoff: InteractionHandoff = {
    version: INTERACTION_DOCUMENT_VERSION,
    to: input.to,
    taskId: session.taskId,
    snapshot: session.snapshot,
    policy: session.policy,
    goal: session.goal,
    decisions: [...session.decisions],
    diff: input.diff,
    checks,
    questions: open,
    nextAction,
    applied: [...session.applied],
    result: session.result,
  };

  return succeeded({
    ...session,
    status: session.status === "done" ? "done" : "handed-off",
    handoff,
  });
}

/** Whether a handoff still matches the current snapshot and policy. */
export function handoffValidity(
  handoff: InteractionHandoff,
  snapshot: string,
  policy: string,
): HandoffValidity {
  if (handoff.snapshot !== snapshot) {
    return {
      valid: false,
      reason: `the snapshot changed from \`${handoff.snapshot}\` to \`${snapshot}\``,
    };
  }
  if (handoff.policy !== policy) {
    return {
      valid: false,
      reason: `the approval policy changed from \`${handoff.policy}\` to \`${policy}\``,
    };
  }
  return { valid: true };
}

/**
 * Recovers a session from one untrusted handoff document and the current public snapshot. Unknown
 * keys are refused, so no conversation, prompt, or model detail can ride along.
 */
export function resumeHandoff(value: unknown, input: ResumeHandoffInput): ResumeHandoffResult {
  const parsed = handoffOf(value);
  if (parsed.handoff === undefined) {
    return { problems: parsed.problems, expired: false };
  }
  const handoff = parsed.handoff;

  const snapshot = textOf(input.snapshot);
  if (!isHash(snapshot)) {
    return {
      problems: [{
        path: "/snapshot",
        code: "interaction.snapshot",
        message: "Resuming a handoff needs the current 64-character snapshot id.",
      }],
      expired: false,
    };
  }
  const policy = textOf(input.policy);
  if (policy === "") {
    return {
      problems: [{
        path: "/policy",
        code: "interaction.policy",
        message: "Resuming a handoff needs the current approval policy.",
      }],
      expired: false,
    };
  }
  const consumer = textOf(input.consumer);
  if (consumer === "") {
    return {
      problems: [{
        path: "/consumer",
        code: "interaction.empty",
        message: "Resuming a handoff needs a non-empty `consumer`.",
      }],
      expired: false,
    };
  }

  const validity = handoffValidity(handoff, snapshot, policy);
  const reason = textOf(input.reason);
  if (!validity.valid && reason === "") {
    return {
      problems: [{
        path: "/reason",
        code: "interaction.handoff-expired",
        message: `The handoff expired because ${validity.reason}; resuming it needs a recorded \`reason\`.`,
      }],
      expired: true,
    };
  }

  const done = handoff.result !== null;
  const stage = input.stage ?? "edit";
  if (!done && !(INTERACTION_STAGES as readonly string[]).includes(stage)) {
    return {
      problems: [{
        path: "/stage",
        code: "interaction.stage",
        message: `A resume stage must be one of: ${INTERACTION_STAGES.map((name) => `\`${name}\``).join(", ")}.`,
      }],
      expired: !validity.valid,
    };
  }
  if (!done && stage === "done") {
    return {
      problems: [{
        path: "/stage",
        code: "interaction.stage",
        message: "A handoff without a result cannot resume in `done`; finish the task with a result.",
      }],
      expired: !validity.valid,
    };
  }

  const session: InteractionSession = {
    version: INTERACTION_DOCUMENT_VERSION,
    taskId: handoff.taskId,
    snapshot,
    policy,
    goal: handoff.goal,
    stage: done ? "done" : stage,
    status: done ? "done" : "active",
    question: null,
    decisions: [...handoff.decisions],
    approvalRequests: [],
    approvals: [],
    refusal: null,
    checkpoint: null,
    handoff: null,
    feedback: [],
    applied: [...handoff.applied],
    resumedBy: [consumer],
    resumeReason: validity.valid ? null : reason,
    result: handoff.result,
  };
  return { session, problems: [], expired: !validity.valid };
}

/** One check, normalized to the public fields. */
function checkOf(
  value: unknown,
  path: string,
  problems: InteractionProblem[],
): InteractionCheck {
  const record = recordOf(value);
  if (record === undefined) {
    problems.push(problemOf(path, "interaction.type", "A check must be an object."));
    return { id: "", status: "skipped" };
  }
  closed(record, CHECK_KEYS, path, problems, "check");
  const id = textOf(record.id);
  if (id === "") problems.push(problemOf(`${path}/id`, "interaction.empty", "A check needs an `id`."));
  if (record.status !== "passed" && record.status !== "failed" && record.status !== "skipped") {
    problems.push(
      problemOf(
        `${path}/status`,
        "interaction.check-status",
        "A check status must be `passed`, `failed`, or `skipped`.",
      ),
    );
  }
  const evidence = record.evidence === undefined ? "" : textOf(record.evidence);
  if (record.evidence !== undefined && evidence === "") {
    problems.push(
      problemOf(`${path}/evidence`, "interaction.empty", "A check evidence reference cannot be empty."),
    );
  }
  return {
    id,
    status:
      record.status === "passed" || record.status === "failed" || record.status === "skipped"
        ? record.status
        : "skipped",
    ...(evidence === "" ? {} : { evidence }),
  };
}

/** One question, normalized to the public fields. */
function questionOf(
  value: unknown,
  path: string,
  problems: InteractionProblem[],
): InteractionQuestion {
  const record = recordOf(value);
  if (record === undefined) {
    problems.push(problemOf(path, "interaction.type", "A question must be an object."));
    return { field: "", question: "", detail: "", choices: [] };
  }
  closed(record, QUESTION_KEYS, path, problems, "question");
  const field = textOf(record.field);
  const question = textOf(record.question);
  const detail = textOf(record.detail);
  if (field === "") problems.push(problemOf(`${path}/field`, "interaction.empty", "A question needs a `field`."));
  if (question === "") {
    problems.push(problemOf(`${path}/question`, "interaction.empty", "A question needs its `question` text."));
  }
  if (detail === "") {
    problems.push(problemOf(`${path}/detail`, "interaction.empty", "A question needs a `detail` sentence."));
  }
  const choices = choiceOf(record.choices, `${path}/choices`, problems);
  return { field, question, detail, choices };
}

/** The choices of one question, each a non-empty string. */
function choiceOf(value: unknown, path: string, problems: InteractionProblem[]): readonly string[] {
  if (!Array.isArray(value)) {
    problems.push(problemOf(path, "interaction.type", "A question `choices` must be an array."));
    return [];
  }
  return value.map((choice, index) => {
    const text = textOf(choice);
    if (text === "") {
      problems.push(problemOf(`${path}/${index}`, "interaction.empty", "A choice cannot be empty."));
    }
    return text;
  });
}

/** Reads an untrusted handoff document, refusing unknown keys at every level it copies. */
function handoffOf(value: unknown): {
  readonly handoff: InteractionHandoff | undefined;
  readonly problems: readonly InteractionProblem[];
} {
  const problems: InteractionProblem[] = [];
  const record = recordOf(value);
  if (record === undefined) {
    return {
      handoff: undefined,
      problems: [problemOf("", "interaction.handoff", "A handoff must be one JSON object.")],
    };
  }
  closed(record, HANDOFF_KEYS, "", problems, "handoff");

  if (record.version !== INTERACTION_DOCUMENT_VERSION) {
    problems.push(problemOf("/version", "interaction.version", "Only handoff version 1 is supported."));
  }
  if (record.to !== "human" && record.to !== "agent") {
    problems.push(problemOf("/to", "interaction.handoff-target", "A handoff target must be `human` or `agent`."));
  }

  const taskId = textOf(record.taskId);
  if (!isHash(taskId)) {
    problems.push(problemOf("/taskId", "interaction.task-id", "`taskId` must be a 64-character SHA-256 digest."));
  }
  const snapshot = textOf(record.snapshot);
  if (!isHash(snapshot)) {
    problems.push(problemOf("/snapshot", "interaction.snapshot", "`snapshot` must be a 64-character SHA-256 digest."));
  }
  const policy = textOf(record.policy);
  if (policy === "") problems.push(problemOf("/policy", "interaction.empty", "A handoff needs a `policy`."));
  const goal = textOf(record.goal);
  if (goal === "") problems.push(problemOf("/goal", "interaction.empty", "A handoff needs a `goal`."));
  const nextAction = textOf(record.nextAction);
  if (nextAction === "") {
    problems.push(problemOf("/nextAction", "interaction.empty", "A handoff needs the next action."));
  }
  if (typeof record.diff !== "string") {
    problems.push(problemOf("/diff", "interaction.diff", "A handoff `diff` must be a string."));
  }
  const applied = stringList(record.applied, "/applied", problems);
  if (record.result !== null && textOf(record.result) === "") {
    problems.push(problemOf("/result", "interaction.result", "A handoff `result` must be a non-empty string or null."));
  }

  const decisions = listOf(record.decisions, "/decisions", problems, (entry, path) => {
    const decision = recordOf(entry);
    if (decision === undefined) {
      problems.push(problemOf(path, "interaction.type", "A decision must be an object."));
      return { subject: "", choice: "", reason: "" };
    }
    closed(decision, DECISION_KEYS, path, problems, "decision");
    const subject = textOf(decision.subject);
    const choice = textOf(decision.choice);
    const reason = textOf(decision.reason);
    if (subject === "") problems.push(problemOf(`${path}/subject`, "interaction.empty", "A decision needs a `subject`."));
    if (choice === "") problems.push(problemOf(`${path}/choice`, "interaction.empty", "A decision needs a `choice`."));
    if (reason === "") problems.push(problemOf(`${path}/reason`, "interaction.empty", "A decision needs a `reason`."));
    return { subject, choice, reason };
  });

  const checks = listOf(record.checks, "/checks", problems, (entry, path) =>
    checkOf(entry, path, problems),
  );
  const questions = listOf(record.questions, "/questions", problems, (entry, path) =>
    questionOf(entry, path, problems),
  );

  if (problems.length > 0) return { handoff: undefined, problems };

  const handoff: InteractionHandoff = {
    version: 1,
    to: record.to === "human" ? "human" : "agent",
    taskId,
    snapshot,
    policy,
    goal,
    decisions,
    diff: typeof record.diff === "string" ? record.diff : "",
    checks,
    questions,
    nextAction,
    applied,
    result: record.result === null ? null : textOf(record.result),
  };
  return { handoff, problems };
}

/** A value as a plain object, or `undefined` for arrays, `null`, and primitives. */
function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** Refuses every key outside `allowed`, so a hidden conversation field cannot be carried. */
function closed(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  problems: InteractionProblem[],
  what: string,
): void {
  for (const key of Object.keys(record)) {
    if (allowed.includes(key)) continue;
    problems.push({
      path: path === "" ? `/${key}` : `${path}/${key}`,
      code: "interaction.unknown-key",
      message: `Unknown ${what} field \`${key}\`; the public document holds no prompt, model, or conversation data.`,
    });
  }
}

/** A list of normalized entries. */
function listOf<T>(
  value: unknown,
  path: string,
  problems: InteractionProblem[],
  entryOf: (entry: unknown, path: string) => T,
): readonly T[] {
  if (!Array.isArray(value)) {
    problems.push(problemOf(path, "interaction.type", "This field must be an array."));
    return [];
  }
  return value.map((entry, index) => entryOf(entry, `${path}/${index}`));
}

/** A list of non-empty strings. */
function stringList(
  value: unknown,
  path: string,
  problems: InteractionProblem[],
): readonly string[] {
  return listOf(value, path, problems, (entry, entryPath) => {
    const text = textOf(entry);
    if (text === "") {
      problems.push(problemOf(entryPath, "interaction.empty", "An entry in this list cannot be empty."));
    }
    return text;
  });
}

/** One problem. */
function problemOf(path: string, code: string, message: string): InteractionProblem {
  return { path, code, message };
}
