/**
 * The parent's authorized view of its subtasks' context packs and proofs (#1199).
 *
 * Each pack and proof stays attached to the subtask and snapshot that produced it. Evidence for a
 * subtask the caller may not read is omitted, not copied; evidence from another snapshot is
 * rejected with a problem, never combined; evidence for a subtask outside the plan is refused. The
 * result lists every snapshot the input named, so a caller can see that two were kept apart.
 */
import type {
  CoordinationAggregate,
  CoordinationAggregateEntry,
  CoordinationPack,
  CoordinationPlan,
  CoordinationProof,
} from "../contracts/coordination.ts";
import type { TaskProblem } from "../contracts/task.ts";
import { byCodePoint } from "./graph.ts";

/** What the parent asks to consume. */
export interface CoordinationAggregateInput {
  readonly plan: CoordinationPlan;
  /** The principal asking; only evidence this principal may read is returned. */
  readonly principal: string;
  readonly packs: readonly CoordinationPack[];
  readonly proofs: readonly CoordinationProof[];
}

/** Aggregates the evidence the parent is allowed to consume, keeping snapshots apart. */
export function aggregateEvidence(input: CoordinationAggregateInput): CoordinationAggregate {
  const problems: TaskProblem[] = [];
  const snapshots = new Set<string>();
  for (const pack of input.packs) snapshots.add(pack.snapshot);
  for (const proof of input.proofs) snapshots.add(proof.snapshot);

  const subtasks = new Map(input.plan.subtasks.map((row) => [row.id, row] as const));

  if (!readable(input.plan.parent.permissions.read, input.principal)) {
    problems.push({
      path: "/principal",
      code: "coordination.aggregate-unauthorized",
      message: `${input.principal} may not read parent ${input.plan.parent.id}; no subtask evidence is returned.`,
    });
    return {
      version: 1,
      parent: input.plan.parent.id,
      snapshot: input.plan.parent.snapshot,
      entries: [],
      snapshots: [...snapshots].sort(byCodePoint),
      problems,
    };
  }

  const packs = indexEvidence(input.packs, "pack", subtasks, problems);
  const proofs = indexEvidence(input.proofs, "proof", subtasks, problems);

  const entries: CoordinationAggregateEntry[] = input.plan.subtasks.map((subtask) => {
    const authorized = readable(subtask.permissions.read, input.principal);
    if (!authorized) {
      return { subtask: subtask.id, snapshot: subtask.snapshot, authorized: false, checks: [] };
    }

    const pack = choose(packs.get(subtask.id) ?? [], subtask.snapshot, "pack", subtask.id, input.plan.parent.snapshot, problems);
    const proof = choose(proofs.get(subtask.id) ?? [], subtask.snapshot, "proof", subtask.id, input.plan.parent.snapshot, problems);
    return {
      subtask: subtask.id,
      snapshot: subtask.snapshot,
      authorized: true,
      goal: subtask.goal,
      ...(pack === undefined ? {} : { pack: pack.pack }),
      ...(proof === undefined
        ? {}
        : { proof: proof.proof, verdict: proof.verdict }),
      checks: proof?.checks ?? [],
    };
  });

  return {
    version: 1,
    parent: input.plan.parent.id,
    snapshot: input.plan.parent.snapshot,
    entries,
    snapshots: [...snapshots].sort(byCodePoint),
    problems: problems.sort((a, b) => byCodePoint(a.path, b.path) || byCodePoint(a.code, b.code)),
  };
}

/** Evidence grouped by subtask, with unknown and duplicate records reported. */
function indexEvidence<T extends CoordinationPack | CoordinationProof>(
  rows: readonly T[],
  kind: "pack" | "proof",
  subtasks: ReadonlyMap<string, { readonly snapshot: string }>,
  problems: TaskProblem[],
): Map<string, T[]> {
  const bySubtask = new Map<string, T[]>();
  rows.forEach((row, index) => {
    if (!subtasks.has(row.subtask)) {
      problems.push({
        path: `/${kind}s/${index}/subtask`,
        code: "coordination.aggregate-unknown",
        message: `${kind} \`${referenceOf(row)}\` names subtask ${row.subtask}, which is not in the plan; it is left out.`,
      });
      return;
    }
    const list = bySubtask.get(row.subtask);
    if (list === undefined) bySubtask.set(row.subtask, [row]);
    else list.push(row);
  });
  return bySubtask;
}

/** The one record for the subtask's snapshot, or `undefined` with a problem when it cannot be used. */
function choose<T extends CoordinationPack | CoordinationProof>(
  rows: readonly T[],
  snapshot: string,
  kind: "pack" | "proof",
  subtask: string,
  parentSnapshot: string,
  problems: TaskProblem[],
): T | undefined {
  const matching = rows.filter((row) => row.snapshot === snapshot).sort(
    (a, b) => byCodePoint(referenceOf(a), referenceOf(b)),
  );
  if (rows.length === 0) return undefined;
  for (const row of rows) {
    if (row.snapshot === snapshot) continue;
    problems.push({
      path: `/${kind}`,
      code: "coordination.aggregate-snapshot",
      message: `${kind} \`${referenceOf(row)}\` for subtask ${subtask} names snapshot ${row.snapshot}, not ${snapshot}; it is kept apart, not combined.`,
    });
  }
  if (matching.length > 1) {
    problems.push({
      path: `/${kind}`,
      code: "coordination.aggregate-duplicate",
      message: `Subtask ${subtask} has ${matching.length} ${kind} records for snapshot ${snapshot}; one is used and the rest are reported.`,
    });
  }
  if (snapshot !== parentSnapshot) {
    problems.push({
      path: `/${kind}`,
      code: "coordination.aggregate-parent-snapshot",
      message: `Subtask ${subtask} is pinned to ${snapshot}, not the parent's ${parentSnapshot}; its evidence cannot be consumed by this parent.`,
    });
    return undefined;
  }
  return matching[0];
}

/** The reference a problem can name without quoting evidence. */
function referenceOf(row: CoordinationPack | CoordinationProof): string {
  return "pack" in row ? row.pack : row.proof;
}

/** True when the principal is allowed by the list. */
function readable(list: readonly string[], principal: string): boolean {
  return list.includes("*") || list.includes(principal);
}
