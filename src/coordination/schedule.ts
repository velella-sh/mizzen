/**
 * When each subtask may run, from the evidence its prerequisites produced (#1197).
 *
 * A subtask's own evidence makes it done. A dependent subtask is ready only when every prerequisite
 * has evidence for the same snapshot; an evidence record from another snapshot never unblocks it,
 * and a prerequisite with a failed check blocks the dependent rather than letting it run on a
 * broken result. Rows follow the plan's dependency order, so a reader sees prerequisites first.
 */
import type {
  CoordinationEvidence,
  CoordinationPlan,
  CoordinationScheduleRow,
  CoordinationSubtask,
} from "../contracts/coordination.ts";

/** Schedules every subtask, or explains what each one is waiting for. */
export function scheduleSubtasks(
  plan: CoordinationPlan,
  evidence: readonly CoordinationEvidence[],
): readonly CoordinationScheduleRow[] {
  const bySubtask = new Map<string, CoordinationEvidence[]>();
  for (const row of evidence) {
    const rows = bySubtask.get(row.subtask);
    if (rows === undefined) bySubtask.set(row.subtask, [row]);
    else rows.push(row);
  }
  const subtasks = new Map(plan.subtasks.map((row) => [row.id, row] as const));

  return plan.order.map((id) => {
    const subtask = subtasks.get(id)!;
    const own = usableEvidence(bySubtask.get(id) ?? [], subtask);
    if (own.kind === "mismatched") return row(subtask, "failed", [], own.detail);
    if (own.kind === "present") return row(subtask, "done", [], "Its evidence is recorded for this snapshot.");

    const missing: string[] = [];
    for (const dependency of subtask.dependsOn) {
      const rows = bySubtask.get(dependency) ?? [];
      const prerequisite = subtasks.get(dependency)!;
      const usable = usableEvidence(rows, prerequisite);
      if (usable.kind === "mismatched") {
        missing.push(dependency);
        continue;
      }
      if (usable.kind === "absent") {
        missing.push(dependency);
        continue;
      }
      const failed = rows
        .filter((row) => row.snapshot === prerequisite.snapshot)
        .flatMap((row) => row.checks)
        .filter((check) => check.status === "failed");
      if (failed.length > 0) {
        return row(
          subtask,
          "blocked",
          [],
          `Prerequisite ${dependency} failed ${failed.map((check) => check.id).join(", ")}; fix it before this subtask starts.`,
        );
      }
    }

    if (missing.length > 0) {
      return row(
        subtask,
        "waiting",
        missing,
        `Waiting for evidence from ${missing.join(", ")}.`,
      );
    }
    return row(subtask, "ready", [], "Every prerequisite produced evidence for this snapshot.");
  });
}

/** What one subtask's evidence says, if anything. */
type Usable =
  | { readonly kind: "present" }
  | { readonly kind: "absent" }
  | { readonly kind: "mismatched"; readonly detail: string };

/** Evidence for the subtask's exact snapshot, or the reason it cannot be used. */
function usableEvidence(
  rows: readonly CoordinationEvidence[],
  subtask: CoordinationSubtask,
): Usable {
  const matching = rows.filter((row) => row.snapshot === subtask.snapshot && row.proof.trim() !== "");
  if (matching.length > 0) return { kind: "present" };
  const other = rows.find((row) => row.snapshot !== subtask.snapshot);
  if (other !== undefined) {
    return {
      kind: "mismatched",
      detail: `Evidence names snapshot ${other.snapshot}, not the subtask's ${subtask.snapshot}; it cannot unblock this work.`,
    };
  }
  return { kind: "absent" };
}

/** One row with its reason. */
function row(
  subtask: CoordinationSubtask,
  state: CoordinationScheduleRow["state"],
  missing: readonly string[],
  reason: string,
): CoordinationScheduleRow {
  return { subtask: subtask.id, state, missing, reason };
}
