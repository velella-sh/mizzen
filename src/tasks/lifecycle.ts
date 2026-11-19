/**
 * The task state machine and its ordered transition events.
 *
 * Eight working states — draft, ready, waiting, running, blocked, verify, done, failed — move only
 * along {@link TASK_TRANSITIONS}; canceled and expired are terminal states added for revocation.
 * Every move appends one event with the task id, the input snapshot, the states on each side, a
 * reason, and a result reference (or `null` when the move produced none), so a document can be
 * audited or replayed without the process that wrote it. Replay checks the sequence, the task id,
 * the snapshot, and each transition, and returns the same final state for the same events in the
 * same order.
 */
import type {
  TaskDocument,
  TaskEvent,
  TaskProblem,
  TaskStatus,
} from "../contracts/task.ts";

/** Every task state, in lifecycle order. */
export const TASK_STATUSES = [
  "draft",
  "ready",
  "waiting",
  "running",
  "blocked",
  "verify",
  "done",
  "failed",
  "canceled",
  "expired",
] as const;

/** The states a task cannot leave. */
export const TASK_TERMINAL_STATUSES = ["done", "failed", "canceled", "expired"] as const;

/** Every allowed transition, by the state it leaves. */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  draft: ["ready", "canceled", "expired"],
  ready: ["running", "waiting", "blocked", "canceled", "expired"],
  waiting: ["ready", "running", "blocked", "canceled", "expired"],
  running: ["verify", "waiting", "blocked", "failed", "canceled", "expired"],
  blocked: ["ready", "running", "waiting", "failed", "canceled", "expired"],
  verify: ["done", "running", "failed", "canceled", "expired"],
  done: [],
  failed: [],
  canceled: [],
  expired: [],
};

/** The states reachable from `state` in one move. */
export function allowedTransitions(state: TaskStatus): readonly TaskStatus[] {
  return TASK_TRANSITIONS[state];
}

/** True when one move from `from` to `to` is allowed. */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

/** What a caller asks {@link transitionTask} to record. */
export interface TaskTransitionRequest {
  /** The state to enter. */
  readonly to: TaskStatus;
  /** Why the task moves. Trimmed; cannot be empty. */
  readonly reason: string;
  /** A reference to the result; required for `verify` and `done`, `null` otherwise. */
  readonly result?: string;
}

/** The result of one transition. */
export interface TaskTransitionResult {
  /** The new document; present exactly when `problems` is empty. */
  readonly task?: TaskDocument;
  /** Why the move was refused; empty on success. */
  readonly problems: readonly TaskProblem[];
}

/** Appends one allowed transition to a task. The input document is never mutated. */
export function transitionTask(
  task: TaskDocument,
  request: TaskTransitionRequest,
): TaskTransitionResult {
  const problems: TaskProblem[] = [];
  const allowed = TASK_TRANSITIONS[task.state];
  if (!allowed.includes(request.to)) {
    problems.push({
      path: "/state",
      code: "task.transition",
      message: allowed.length === 0
        ? `Task \`${task.id}\` is \`${task.state}\`, a terminal state; it cannot move to \`${request.to}\`.`
        : `A task cannot move from \`${task.state}\` to \`${request.to}\`; allowed next states: ${allowed.map((state) => `\`${state}\``).join(", ")}.`,
    });
  }

  const reason = request.reason.trim();
  if (reason === "") {
    problems.push({
      path: "/reason",
      code: "task.reason-empty",
      message: "A transition needs a non-empty reason.",
    });
  }

  const result = request.result?.trim() ?? null;
  if (result === "") {
    problems.push({
      path: "/result",
      code: "task.result-empty",
      message: "A result reference cannot be empty; omit it when the transition produced no result.",
    });
  }
  if (result === null && (request.to === "verify" || request.to === "done")) {
    problems.push({
      path: "/result",
      code: "task.result-required",
      message: `A transition to \`${request.to}\` needs a non-empty result reference.`,
    });
  }

  if (problems.length > 0) return { problems };

  const event: TaskEvent = {
    sequence: task.events.length,
    taskId: task.id,
    snapshot: task.snapshot.id,
    from: task.state,
    to: request.to,
    reason,
    result,
  };
  return { task: { ...task, state: request.to, events: [...task.events, event] }, problems: [] };
}

/** The result of replaying a task's events. */
export interface TaskReplayResult {
  /** The final state; present exactly when `problems` is empty. */
  readonly state?: TaskStatus;
  /** Why the events do not replay; empty on success. */
  readonly problems: readonly TaskProblem[];
}

/** Replays ordered events and returns the state they produce, or every reason they are invalid. */
export function replayTask(
  taskId: string,
  events: readonly TaskEvent[],
): TaskReplayResult {
  const problems: TaskProblem[] = [];
  if (events.length === 0) {
    return {
      problems: [
        {
          path: "/events",
          code: "task.event-empty",
          message: "A task needs at least its registration event.",
        },
      ],
    };
  }

  let state: TaskStatus | null = null;
  let snapshot: string | null = null;

  events.forEach((event, index) => {
    if (event.sequence !== index) {
      problems.push({
        path: `/events/${index}/sequence`,
        code: "task.event-sequence",
        message: `Event ${index} has sequence ${event.sequence}; events must be ordered from 0 without gaps.`,
      });
    }
    if (event.taskId !== taskId) {
      problems.push({
        path: `/events/${index}/taskId`,
        code: "task.event-task",
        message: `Event ${index} belongs to task \`${event.taskId}\`, not \`${taskId}\`.`,
      });
    }

    if (index === 0) {
      snapshot = event.snapshot;
      if (event.from !== null) {
        problems.push({
          path: "/events/0/from",
          code: "task.event-from",
          message: "The first event registers the task and must have `from: null`.",
        });
      }
      if (event.to !== "draft") {
        problems.push({
          path: "/events/0/to",
          code: "task.event-registration",
          message: "The first event must register the task in `draft`.",
        });
      }
    } else {
      if (event.snapshot !== snapshot) {
        problems.push({
          path: `/events/${index}/snapshot`,
          code: "task.event-snapshot",
          message: `Event ${index} names snapshot \`${event.snapshot}\`, but the task was registered against \`${snapshot ?? ""}\`.`,
        });
      }
      if (state === null || event.from !== state) {
        problems.push({
          path: `/events/${index}/from`,
          code: "task.event-from",
          message: `Event ${index} starts from \`${event.from ?? "null"}\`, but the replay is in \`${state ?? "no state"}\`.`,
        });
      } else if (!canTransition(event.from, event.to)) {
        problems.push({
          path: `/events/${index}/to`,
          code: "task.transition",
          message: `The replay cannot move from \`${event.from}\` to \`${event.to}\`.`,
        });
      }
    }
    state = event.to;
  });

  return problems.length === 0 ? { state: state ?? "draft", problems } : { problems };
}
