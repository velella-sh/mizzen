/**
 * Semantic ownership over pages, blocks, symbols, records, and files (#1194).
 *
 * A subtask owns every reference in its scope. Before two subtasks may run at the same time, their
 * scopes are compared: one shared reference is enough to refuse the second start, and the refusal
 * names both subtasks and the reference. Sequential subtasks may still share a reference when the
 * dependency edge makes that explicit; the check is about concurrent writers.
 */
import type {
  CoordinationOverlap,
  CoordinationOwnership,
  CoordinationPlan,
  CoordinationStartBlocker,
  CoordinationStartResult,
  CoordinationSubtask,
} from "../contracts/coordination.ts";
import { byCodePoint } from "./graph.ts";

/** The scope kinds and the name ownership reports them under. */
const OWNERSHIP_KINDS = [
  ["pages", "page"],
  ["blocks", "block"],
  ["symbols", "symbol"],
  ["records", "record"],
  ["files", "file"],
] as const;

/** Every reference every subtask owns, sorted by kind, reference, then subtask id. */
export function ownershipOf(subtasks: readonly CoordinationSubtask[]): readonly CoordinationOwnership[] {
  const rows: CoordinationOwnership[] = [];
  for (const subtask of subtasks) {
    for (const [field, kind] of OWNERSHIP_KINDS) {
      for (const ref of subtask.scope[field]) rows.push({ subtask: subtask.id, kind, ref });
    }
  }
  return rows.sort(
    (a, b) =>
      byCodePoint(a.kind, b.kind) ||
      byCodePoint(a.ref, b.ref) ||
      byCodePoint(a.subtask, b.subtask),
  );
}

/** Every pair of subtasks that name the same reference, sorted by kind, reference, then ids. */
export function overlappingOwnership(
  subtasks: readonly CoordinationSubtask[],
): readonly CoordinationOverlap[] {
  const byReference = new Map<string, CoordinationOwnership[]>();
  for (const row of ownershipOf(subtasks)) {
    const key = `${row.kind}\0${row.ref}`;
    const rows = byReference.get(key);
    if (rows === undefined) byReference.set(key, [row]);
    else rows.push(row);
  }

  const overlaps: CoordinationOverlap[] = [];
  for (const rows of byReference.values()) {
    for (let left = 0; left < rows.length; left += 1) {
      for (let right = left + 1; right < rows.length; right += 1) {
        const a = rows[left]!;
        const b = rows[right]!;
        if (a.subtask === b.subtask) continue;
        const [first, second] = a.subtask < b.subtask ? [a.subtask, b.subtask] : [b.subtask, a.subtask];
        overlaps.push({
          kind: a.kind,
          ref: a.ref,
          subtasks: [first, second],
          message: `Subtask ${first} and subtask ${second} both write ${a.kind} "${a.ref}"; start them one at a time or give each its own scope.`,
        });
      }
    }
  }
  return overlaps.sort(
    (a, b) =>
      byCodePoint(a.kind, b.kind) ||
      byCodePoint(a.ref, b.ref) ||
      byCodePoint(a.subtasks[0], b.subtasks[0]) ||
      byCodePoint(a.subtasks[1], b.subtasks[1]),
  );
}

/**
 * Checks whether `subtask` may start while `active` subtasks are running. A missing subtask and
 * every shared reference with an active subtask are blockers; an empty blocker list means start.
 */
export function checkStart(
  plan: CoordinationPlan,
  subtask: string,
  active: readonly string[],
): CoordinationStartResult {
  const candidate = plan.subtasks.find((row) => row.id === subtask);
  if (candidate === undefined) {
    return {
      ready: false,
      blockers: [
        {
          code: "coordination.not-ready",
          message: `Subtask ${subtask} is not in plan ${plan.parent.id}.`,
        },
      ],
    };
  }

  const running = new Set(active);
  const blockers: CoordinationStartBlocker[] = [];
  for (const overlap of overlappingOwnership(plan.subtasks)) {
    if (!overlap.subtasks.includes(subtask)) continue;
    const other = overlap.subtasks[0] === subtask ? overlap.subtasks[1] : overlap.subtasks[0];
    if (!running.has(other)) continue;
    blockers.push({
      code: "coordination.scope-overlap",
      message: overlap.message,
      other,
    });
  }

  return { ready: blockers.length === 0, blockers };
}
