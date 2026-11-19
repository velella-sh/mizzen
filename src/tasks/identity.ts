/**
 * Deterministic identities for a task, its registration request, and its input snapshot.
 *
 * None of the three reads a clock, a path, an environment variable, or a random source: the same
 * bytes always give the same id on any machine. A task id comes from the caller's idempotency key,
 * a request id from the normalized contract, and a snapshot id from the four input hashes.
 */
import type { TaskContract, TaskSnapshot } from "../contracts/task.ts";
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

/** The snapshot id: the four effective-input hashes, in canonical key order. */
export function snapshotIdOf(snapshot: Omit<TaskSnapshot, "id">): string {
  return sha256(
    `mizzen-task-snapshot\0${canonicalJson({
      content: snapshot.content,
      data: snapshot.data,
      config: snapshot.config,
      tooling: snapshot.tooling,
    })}`,
  );
}
