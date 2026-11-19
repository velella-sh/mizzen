/**
 * Deterministic identities for a task and its registration request.
 *
 * Neither reads a clock, a path, an environment variable, or a random source: the same bytes
 * always give the same id on any machine. A task id comes from the caller's idempotency key and a
 * request id from the normalized contract; the snapshot id lives in `snapshot.ts`.
 */
import type { TaskContract } from "../contracts/task.ts";
import { canonicalJson, sha256 } from "../data/lock.ts";

/** The task id: the idempotency key alone, so repeating a key always addresses the same task. */
export function taskIdOf(idempotencyKey: string): string {
  return sha256(`mizzen-task\0${idempotencyKey}`);
}

/**
 * The request id: the normalized content without the idempotency key, so the same content with a
 * different key still names the same request while the task id follows the key.
 */
export function requestIdOf(contract: TaskContract): string {
  return sha256(
    `mizzen-task-request\0${canonicalJson({
      version: contract.version,
      goal: contract.goal,
      scope: contract.scope,
      snapshot: contract.snapshot,
      budget: contract.budget,
      permissions: contract.permissions,
      acceptance: contract.acceptance,
    })}`,
  );
}

