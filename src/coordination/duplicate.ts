/**
 * Detect and decide duplicate work (#1198).
 *
 * Two subtasks are duplicates when all three match: the same normalized goal, the same snapshot,
 * and the same set of owned references. The report names the pair, gives the three reasons in a
 * fixed order, and never decides on its own. A caller records `merge` or `keep-separate` with a
 * reason, so an empty or missing decision can never be mistaken for either.
 */
import type {
  CoordinationDuplicateDecision,
  CoordinationDuplicateMatch,
  CoordinationSubtask,
} from "../contracts/coordination.ts";
import type { TaskProblem } from "../contracts/task.ts";
import { byCodePoint } from "./graph.ts";

/** The scope fields compared for duplicate work. */
const KINDS = ["pages", "blocks", "symbols", "records", "files"] as const;

/** Every duplicate pair, sorted by the two subtask ids. */
export function duplicateSubtasks(
  subtasks: readonly CoordinationSubtask[],
): readonly CoordinationDuplicateMatch[] {
  const ordered = [...subtasks].sort((a, b) => byCodePoint(a.id, b.id));
  const matches: CoordinationDuplicateMatch[] = [];
  for (let left = 0; left < ordered.length; left += 1) {
    for (let right = left + 1; right < ordered.length; right += 1) {
      const a = ordered[left]!;
      const b = ordered[right]!;
      const reasons: CoordinationDuplicateMatch["reasons"][number][] = [];
      if (normalizedGoal(a.goal) === normalizedGoal(b.goal)) reasons.push("goal");
      if (a.snapshot === b.snapshot) reasons.push("snapshot");
      if (sameScope(a, b)) reasons.push("scope");
      if (reasons.length !== 3) continue;
      matches.push({
        subtask: a.id,
        other: b.id,
        reasons,
        message: `Subtasks ${a.id} and ${b.id} share a goal, a snapshot, and a scope; decide to merge them or keep them separate.`,
      });
    }
  }
  return matches;
}

/** Records an explicit merge or keep-separate decision for one match. */
export function decideDuplicate(
  match: CoordinationDuplicateMatch,
  choice: CoordinationDuplicateDecision["choice"],
  reason: string,
): { readonly decision?: CoordinationDuplicateDecision; readonly problems: readonly TaskProblem[] } {
  const trimmed = reason.trim();
  if (trimmed === "") {
    return {
      problems: [
        {
          path: "/reason",
          code: "coordination.duplicate-reason",
          message: "A duplicate decision needs a non-empty reason, so a later agent knows why.",
        },
      ],
    };
  }
  return {
    decision: {
      version: 1,
      subtask: match.subtask,
      other: match.other,
      choice,
      reason: trimmed,
    },
    problems: [],
  };
}

/** Goal comparison ignores case and runs of whitespace, never locale. */
function normalizedGoal(goal: string): string {
  return goal.trim().replace(/\s+/g, " ").toLowerCase();
}

/** True when both subtasks own exactly the same references, whatever order they were written in. */
function sameScope(a: CoordinationSubtask, b: CoordinationSubtask): boolean {
  return KINDS.every((kind) => {
    const left = [...a.scope[kind]].sort(byCodePoint);
    const right = [...b.scope[kind]].sort(byCodePoint);
    return left.length === right.length && left.every((ref, index) => ref === right[index]);
  });
}
