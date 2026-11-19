/**
 * Register one task from untrusted input.
 *
 * A registration resolves by idempotency key: the task id is the SHA-256 of the key, so two
 * registrations of the same content with the same key return one task and write one event list.
 * The same key with different content is a conflict rather than a silent overwrite, and the same
 * content with a different key is a different task. Nothing here reads a clock or a local path, so
 * the ids and the first event are byte-identical on every machine.
 */
import type {
  TaskContract,
  TaskDocument,
  TaskEvent,
  TaskProblem,
} from "../contracts/task.ts";
import { parseTaskContract, type TaskParseOptions } from "./contract.ts";
import { requestIdOf, taskIdOf } from "./identity.ts";

/** What registration needs besides the document. */
export interface TaskRegistrationOptions extends TaskParseOptions {
  /** Tasks already known. A matching id makes the call idempotent or a conflict. */
  readonly existing?: readonly TaskDocument[];
}

/** The result of one registration. */
export interface TaskRegistrationResult {
  /** The existing or newly created task; present exactly when `problems` is empty. */
  readonly task?: TaskDocument;
  /** True when this call created the task; false when it returned an existing one. */
  readonly created: boolean;
  /** Why the registration was refused; empty on success. */
  readonly problems: readonly TaskProblem[];
}

/** Registers a task, or returns the one the same idempotency key already addresses. */
export function registerTask(
  value: unknown,
  options: TaskRegistrationOptions = {},
): TaskRegistrationResult {
  const parsed = parseTaskContract(value, {
    ...(options.checks === undefined ? {} : { checks: options.checks }),
    ...(options.references === undefined ? {} : { references: options.references }),
  });
  if (parsed.contract === undefined) {
    return { created: false, problems: parsed.problems };
  }

  const id = taskIdOf(parsed.contract.idempotencyKey);
  const requestId = requestIdOf(parsed.contract);
  const existing = options.existing?.find((task) => task.id === id);
  if (existing !== undefined) {
    if (existing.requestId === requestId) {
      return { task: existing, created: false, problems: [] };
    }
    return {
      created: false,
      problems: [
        {
          path: "/idempotencyKey",
          code: "task.idempotency-conflict",
          message: `Task \`${id}\` already exists with different content; use a new \`idempotencyKey\` for the changed task or repeat the original content.`,
        },
      ],
    };
  }

  return { task: documentOf(parsed.contract, id, requestId), created: true, problems: [] };
}

/** The registered document: fixed key order, state `draft`, and the registration event. */
function documentOf(contract: TaskContract, id: string, requestId: string): TaskDocument {
  const event: TaskEvent = {
    sequence: 0,
    taskId: id,
    snapshot: contract.snapshot.id,
    from: null,
    to: "draft",
    reason: "Task registered.",
    result: null,
  };
  return {
    version: contract.version,
    id,
    requestId,
    idempotencyKey: contract.idempotencyKey,
    goal: contract.goal,
    scope: contract.scope,
    snapshot: contract.snapshot,
    budget: contract.budget,
    permissions: contract.permissions,
    acceptance: contract.acceptance,
    state: "draft",
    events: [event],
  };
}
