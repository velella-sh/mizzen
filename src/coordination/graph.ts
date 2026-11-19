/**
 * The dependency graph shared by splitting and merging.
 *
 * Order is Kahn's algorithm with one rule for ties: the smaller id goes first. The same edges
 * therefore always produce the same order, whatever order the caller supplied the subtasks in.
 * A node that never becomes ready is part of a cycle (or depends on one) and is reported by id
 * instead of being scheduled.
 */
import type { TaskProblem } from "../contracts/task.ts";

/** The two fields ordering needs from a subtask. */
export interface CoordinationNode {
  readonly id: string;
  readonly dependsOn: readonly string[];
}

/** What ordering found. */
export interface CoordinationOrderResult {
  readonly order: readonly string[];
  /** Ids that could not be ordered because of a cycle, sorted. */
  readonly cycles: readonly string[];
  /** A dependency that names no node in the graph. */
  readonly unknown: readonly { readonly subtask: string; readonly dependency: string }[];
  readonly problems: readonly TaskProblem[];
}

/** Orders nodes by dependency, smaller id first, or explains every edge that prevents it. */
export function orderSubtasks(nodes: readonly CoordinationNode[]): CoordinationOrderResult {
  const ids = new Set(nodes.map((node) => node.id));
  const unknown: { subtask: string; dependency: string }[] = [];
  const problems: TaskProblem[] = [];

  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (ids.has(dependency)) continue;
      unknown.push({ subtask: node.id, dependency });
      problems.push({
        path: `/subtasks/${node.id}/dependsOn`,
        code: "coordination.dependency-unknown",
        message: `Subtask \`${node.id}\` depends on \`${dependency}\`, which is not in the plan; add it or remove the dependency.`,
      });
    }
  }
  if (problems.length > 0) return { order: [], cycles: [], unknown, problems };

  const remaining = new Map(nodes.map((node) => [node.id, new Set(node.dependsOn)] as const));
  const order: string[] = [];
  for (;;) {
    const ready = [...remaining]
      .filter(([, dependencies]) => dependencies.size === 0)
      .map(([id]) => id)
      .sort(byCodePoint);
    if (ready.length === 0) break;
    const next = ready[0]!;
    remaining.delete(next);
    order.push(next);
    for (const dependencies of remaining.values()) dependencies.delete(next);
  }

  const cycles = [...remaining.keys()].sort(byCodePoint);
  if (cycles.length > 0) {
    problems.push({
      path: "/subtasks",
      code: "coordination.dependency-cycle",
      message: `Subtasks ${cycles.map((id) => `\`${id}\``).join(", ")} depend on each other in a cycle; break the cycle before splitting the work.`,
    });
  }
  return { order, cycles, unknown, problems };
}

/** Compares by code point, never by locale. */
export function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
