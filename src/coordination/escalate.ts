/**
 * Send an unresolvable merge conflict to the parent task or a person (#1201).
 *
 * An escalation carries both sides of every conflict: the subtask, its diff, the evidence behind
 * it, and the files it claims. The escalation starts `open` with no winner. Resolving it requires
 * an explicit `left` or `right` and a reason; there is no default and no rule that the agent that
 * finished last wins.
 */
import type {
  CoordinationEscalation,
  CoordinationEscalationResult,
  CoordinationEscalationSide,
  CoordinationMerge,
  CoordinationSubtaskResult,
} from "../contracts/coordination.ts";
import type { TaskProblem } from "../contracts/task.ts";
import { canonicalJson, sha256 } from "../data/lock.ts";
import { byCodePoint } from "./graph.ts";

/** What escalating a merge needs. */
export interface CoordinationEscalationInput {
  readonly merge: CoordinationMerge;
  /** The results behind the conflicting sides, in any order. */
  readonly results: readonly CoordinationSubtaskResult[];
  readonly target: "parent" | "human";
}

/** Builds an open escalation with both sides, or refuses when there is nothing to escalate. */
export function escalateMerge(input: CoordinationEscalationInput): CoordinationEscalationResult {
  const problems: TaskProblem[] = [];
  if (input.target !== "parent" && input.target !== "human") {
    problems.push({
      path: "/target",
      code: "coordination.escalation-target",
      message: "An escalation goes to `parent` or `human`; choose one.",
    });
  }
  if (input.merge.conflicts.length === 0) {
    problems.push({
      path: "/merge/conflicts",
      code: "coordination.escalation-empty",
      message: `Merge ${input.merge.id} has no conflict; apply it instead of escalating it.`,
    });
  }
  if (problems.length > 0) return { problems };

  const bySubtask = new Map(input.results.map((result) => [result.subtask, result] as const));
  const ids = [...new Set(input.merge.conflicts.flatMap((conflict) => conflict.subtasks))].sort(byCodePoint);
  const sides: CoordinationEscalationSide[] = ids.flatMap((id) => {
    const result = bySubtask.get(id);
    if (result === undefined) return [];
    return [
      {
        subtask: id,
        snapshot: result.snapshot,
        diff: result.diff,
        evidence: result.evidence,
        files: result.files,
      },
    ];
  });

  const escalation: CoordinationEscalation = {
    version: 1,
    id: escalationIdOf(input.merge, input.target, sides),
    parent: input.merge.parent,
    target: input.target,
    conflicts: input.merge.conflicts,
    sides,
    status: "open",
  };
  return { escalation, problems: [] };
}

/** Records an explicit `left` or `right` decision; never picks a side on its own. */
export function resolveEscalation(
  escalation: CoordinationEscalation,
  choice: "left" | "right",
  reason: string,
): { readonly escalation?: CoordinationEscalation; readonly problems: readonly TaskProblem[] } {
  const problems: TaskProblem[] = [];
  if (escalation.status !== "open") {
    problems.push({
      path: "/status",
      code: "coordination.escalation-closed",
      message: `Escalation ${escalation.id} is already ${escalation.status}; record a new escalation for a new conflict.`,
    });
  }
  if (escalation.sides.length < 2) {
    problems.push({
      path: "/sides",
      code: "coordination.escalation-sides",
      message: `Escalation ${escalation.id} has ${escalation.sides.length} side(s); a left/right decision needs both.`,
    });
  }
  const trimmed = reason.trim();
  if (trimmed === "") {
    problems.push({
      path: "/reason",
      code: "coordination.escalation-reason",
      message: "A resolution needs a non-empty reason.",
    });
  }
  if (problems.length > 0) return { problems };

  const chosen = escalation.sides[choice === "left" ? 0 : 1]!;
  return {
    escalation: {
      ...escalation,
      status: "resolved",
      decision: { choice, subtask: chosen.subtask, reason: trimmed },
    },
    problems: [],
  };
}

/** The escalation id: parent, target, conflicts, and both sides; no clock and no arrival order. */
function escalationIdOf(
  merge: CoordinationMerge,
  target: "parent" | "human",
  sides: readonly CoordinationEscalationSide[],
): string {
  return sha256(
    `mizzen-coordination-escalation\0${canonicalJson({ parent: merge.parent, target, conflicts: merge.conflicts, sides })}`,
  );
}
