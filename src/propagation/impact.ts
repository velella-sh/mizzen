/**
 * The impact of one upstream release on one consumer: the strongest severity, the action the consumer's policy asks
 * for, the downstream snapshot the change reaches, the pages it names, and the deterministic task proposal ids it
 * produces. This is computed before anything is published, so a preview can show it.
 */
import type {
  AffectedDependency,
  ConsumerDeclaration,
  ConsumerImpact,
  PropagationAction,
  SnapshotView,
} from "../contracts/propagation.ts";
import { actionFor, propagationIdOf, taskProposalIdOf, uniqueSorted } from "./contract.ts";
import { distinctChanges } from "./match.ts";
import { overallSeverity } from "./severity.ts";

/** True when an action produces a task proposal. */
export function createsTask(action: PropagationAction): boolean {
  return action === "task" || action === "pull-request" || action === "review";
}

/** The receipt id a change set produces for one consumer. */
export function receiptIdFor(
  consumer: ConsumerDeclaration,
  current: SnapshotView,
  changes: readonly AffectedDependency["change"][],
): string {
  return propagationIdOf(
    consumer.id,
    { project: current.project, id: current.snapshot.id, version: current.snapshot.version },
    changes,
  );
}

/** Builds one consumer's impact, or `undefined` when no declared dependency is affected. */
export function impactOf(input: {
  readonly consumer: ConsumerDeclaration;
  readonly baseline: SnapshotView;
  readonly current: SnapshotView;
  readonly affected: readonly AffectedDependency[];
}): ConsumerImpact | undefined {
  const { consumer, baseline, current, affected } = input;
  if (affected.length === 0) return undefined;
  const changes = distinctChanges(affected);
  const severity = overallSeverity(affected.map((entry) => entry.severity));
  const action = actionFor(consumer.policy, severity);
  const receiptId = receiptIdFor(consumer, current, changes);
  const pages = uniqueSorted([
    ...affected.flatMap((entry) => entry.dependency.pages ?? []),
    ...changes.flatMap((change) => change.pages ?? []),
  ]);
  const refs = uniqueSorted(changes.map((change) => change.ref));
  const reason =
    `${changes.length} semantic change${changes.length === 1 ? "" : "s"} in ${current.project} ` +
    `${current.snapshot.version} affects ${refs.join(", ")}; the policy classifies it ${severity} and asks for ${action}.`;
  return {
    consumer: consumer.id,
    project: current.project,
    snapshot: current.snapshot,
    severity,
    action,
    affected,
    snapshots: [
      {
        project: consumer.id,
        ...(baseline.snapshot.version === current.snapshot.version ? {} : { from: baseline.snapshot.version }),
        to: current.snapshot.version,
      },
    ],
    pages,
    tasks: createsTask(action) ? [taskProposalIdOf(receiptId, consumer.id)] : [],
    reason,
  };
}
