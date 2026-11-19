/**
 * Input snapshots: the four effective-input hashes a task is pinned to.
 *
 * A snapshot is content, data, config, and tooling, plus the id derived from them. Changing any
 * hash changes the id, so a re-registration with a changed input cannot be mistaken for the same
 * request. Nothing here reads a clock, a path, or the inputs themselves: the caller supplies the
 * effective hashes it measured, and this module gives them one stable shape and identity.
 */
import type { TaskSnapshot } from "../contracts/task.ts";
import { canonicalJson, sha256 } from "../data/lock.ts";

/** The four hashes, without the derived id. */
export type TaskSnapshotInput = Omit<TaskSnapshot, "id">;

/** The four input hashes that make a snapshot. */
export interface TaskInputHashes {
  readonly content: string;
  readonly data: string;
  readonly config: string;
  readonly tooling: string;
}

/** The snapshot id: the four effective-input hashes, in canonical key order. */
export function snapshotIdOf(snapshot: TaskSnapshotInput): string {
  return sha256(
    `mizzen-task-snapshot\0${canonicalJson({
      content: snapshot.content,
      data: snapshot.data,
      config: snapshot.config,
      tooling: snapshot.tooling,
    })}`,
  );
}

/** A snapshot from the four hashes, with its derived id. */
export function taskSnapshot(hashes: TaskInputHashes): TaskSnapshot {
  return { ...hashes, id: snapshotIdOf(hashes) };
}

/** True when the inputs no longer produce the snapshot the task recorded. */
export function snapshotChanged(before: TaskSnapshot, after: TaskInputHashes | TaskSnapshot): boolean {
  return before.id !== taskSnapshot(after).id;
}
