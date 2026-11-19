/**
 * Combine subtask results deterministically (#1200).
 *
 * Transactions are ordered by the dependency graph, with the smaller subtask id first among equal
 * prerequisites. A result's `finishedAt` is never read, so two agents finishing in either order
 * produce the same merge and the same merge id.
 *
 * A file written by an earlier subtask may be written again only when the later result starts from
 * the hash the earlier one produced (a real dependency), or when it produces exactly the same
 * final hash (identical work). Anything else is a conflict for the parent or a person to resolve,
 * never a silent last-writer-wins overwrite.
 */
import type {
  CoordinationMerge,
  CoordinationMergeConflict,
  CoordinationMergeEntry,
  CoordinationPlan,
  CoordinationSubtaskResult,
} from "../contracts/coordination.ts";
import { canonicalJson, sha256 } from "../data/lock.ts";
import { byCodePoint } from "./graph.ts";

/** The final state of one file, and the subtask that produced it. */
interface FinalFile {
  readonly hash: string | null;
  readonly subtask: string;
  /** The hash the first writer started from. */
  readonly before: string | null;
}

/** Merges every available result in dependency order. */
export function mergeSubtaskResults(
  plan: CoordinationPlan,
  results: readonly CoordinationSubtaskResult[],
): CoordinationMerge {
  const conflicts: CoordinationMergeConflict[] = [];
  const known = new Set(plan.subtasks.map((row) => row.id));
  const bySubtask = new Map<string, CoordinationSubtaskResult>();

  for (const result of results) {
    if (!known.has(result.subtask)) {
      conflicts.push({
        kind: "unknown-result",
        subtasks: [result.subtask],
        message: `Result ${result.subtask} belongs to no subtask in plan ${plan.parent.id}; it is left out.`,
      });
      continue;
    }
    if (bySubtask.has(result.subtask)) {
      conflicts.push({
        kind: "duplicate-result",
        subtasks: [result.subtask],
        message: `Subtask ${result.subtask} returned more than one result; only the first is used.`,
      });
      continue;
    }
    if (result.snapshot !== plan.parent.snapshot) {
      conflicts.push({
        kind: "snapshot",
        subtasks: [result.subtask],
        message: `Result ${result.subtask} is for snapshot ${result.snapshot}, not the plan's ${plan.parent.snapshot}; it is left out.`,
      });
      continue;
    }
    bySubtask.set(result.subtask, result);
  }

  const finals = new Map<string, FinalFile>();
  const order: CoordinationMergeEntry[] = [];
  for (const id of plan.order) {
    const result = bySubtask.get(id);
    if (result === undefined) {
      conflicts.push({
        kind: "missing-result",
        subtasks: [id],
        message: `Subtask ${id} produced no result; the merge is partial.`,
      });
      order.push({ subtask: id, transactions: [], files: [] });
      continue;
    }

    const files = [...result.files].sort((a, b) => byCodePoint(a.file, b.file));
    const seen = new Set<string>();
    for (const file of files) {
      if (seen.has(file.file)) {
        conflicts.push({
          kind: "same-file",
          subtasks: [id],
          file: file.file,
          message: `Subtask ${id} lists ${file.file} more than once; only the first entry is used.`,
        });
        continue;
      }
      seen.add(file.file);

      const prior = finals.get(file.file);
      if (prior === undefined) {
        finals.set(file.file, { hash: file.afterHash, subtask: id, before: file.beforeHash });
        continue;
      }
      if (file.beforeHash === prior.hash || file.afterHash === prior.hash) {
        finals.set(file.file, { ...prior, hash: file.afterHash, subtask: id });
        continue;
      }
      conflicts.push({
        kind: "stale-before",
        subtasks: [prior.subtask, id].sort(byCodePoint),
        file: file.file,
        message: `Subtask ${id} changes ${file.file} from ${file.beforeHash ?? "an absent file"}, but subtask ${prior.subtask} left it at ${prior.hash ?? "an absent file"}; resolve both diffs explicitly.`,
      });
    }
    order.push({ subtask: id, transactions: result.transactions, files });
  }

  const sortedConflicts = conflicts.sort(
    (a, b) =>
      byCodePoint(a.kind, b.kind) ||
      byCodePoint(a.file ?? "", b.file ?? "") ||
      byCodePoint(a.subtasks.join(","), b.subtasks.join(",")),
  );
  const files = [...finals]
    .map(([file, final]) => ({ file, hash: final.hash }))
    .sort((a, b) => byCodePoint(a.file, b.file));
  const content = {
    parent: plan.parent.id,
    snapshot: plan.parent.snapshot,
    order,
    files,
    conflicts: sortedConflicts,
  };

  return {
    version: 1,
    parent: plan.parent.id,
    snapshot: plan.parent.snapshot,
    order,
    files,
    conflicts: sortedConflicts,
    id: sha256(`mizzen-coordination-merge\0${canonicalJson(content)}`),
  };
}

/** True when two results change the same file from the same base in different ways. */
export function conflictingFiles(
  left: CoordinationSubtaskResult,
  right: CoordinationSubtaskResult,
): readonly string[] {
  const rightFiles = new Map(right.files.map((file) => [file.file, file] as const));
  return left.files
    .filter((file) => {
      const other = rightFiles.get(file.file);
      return other !== undefined && file.beforeHash === other.beforeHash && file.afterHash !== other.afterHash;
    })
    .map((file) => file.file)
    .sort(byCodePoint);
}
