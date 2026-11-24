/**
 * Preview and apply: the two operations a release runs before and after it publishes. A preview diffs every upstream
 * project it was given, matches the changes against the consumer manifest, and reports the downstream snapshots, pages,
 * and task proposal ids each consumer is asked about. An apply turns the matching impacts into receipts; a receipt
 * that already exists is returned unchanged, so reprocessing the same snapshots creates no duplicate task or pull
 * request. A consumer whose bundle is missing or unreadable is recorded beside the consumers that succeeded, never in
 * place of them.
 */
import type {
  ConsumerDeclaration,
  ConsumerImpact,
  PropagationApplyResult,
  PropagationFailure,
  PropagationLedger,
  PropagationManifest,
  PropagationPreview,
  PropagationReceipt,
  PropagationReceiptStatus,
  SemanticChange,
  SnapshotIdentity,
  SnapshotView,
  TaskProposal,
} from "../contracts/propagation.ts";
import { byCodePoint, changeSetHash, compareChanges, stableHash } from "./contract.ts";
import { diffSnapshots } from "./diff.ts";
import { createsTask, impactOf, receiptIdFor } from "./impact.ts";
import { distinctChanges, matchChanges } from "./match.ts";
import { proposeTask } from "./propose.ts";
import { findReceipt, recordReceipt, replaceReceipt } from "./receipt.ts";
import { identityOfSnapshot, isReadable } from "./snapshot.ts";

/** What a preview reads. Both maps are the locked snapshots, by project id. */
export interface PropagationPreviewInput {
  readonly manifest: PropagationManifest;
  readonly baseline: ReadonlyMap<string, SnapshotView>;
  readonly current: ReadonlyMap<string, SnapshotView>;
  /** Audiences the caller may read; without it only public snapshots are visible. */
  readonly allow?: readonly string[];
}

/** What an apply reads: a preview's input, the existing ledger, and any approvals already granted. */
export interface PropagationApplyInput extends PropagationPreviewInput {
  readonly ledger: PropagationLedger;
  /** Approved principals by consumer id. */
  readonly approvals?: Readonly<Record<string, readonly string[]>>;
}

/** One project's diff, or why it could not be read. */
type ProjectState =
  | { readonly events: readonly SemanticChange[] }
  | { readonly failure: Omit<PropagationFailure, "consumer"> };

/** The snapshots a preview names, sorted by project. */
function identitiesOf(snapshots: ReadonlyMap<string, SnapshotView>): SnapshotIdentity[] {
  return [...snapshots.values()]
    .map(identityOfSnapshot)
    .sort((a, b) => byCodePoint(a.project, b.project) || byCodePoint(a.snapshot.id, b.snapshot.id));
}

/** The distinct events across projects, sorted. */
function mergeEvents(states: ReadonlyMap<string, ProjectState>): SemanticChange[] {
  const seen = new Set<string>();
  const events: SemanticChange[] = [];
  for (const state of states.values()) {
    if (!("events" in state)) continue;
    for (const event of state.events) {
      const key = `${event.project}\u0000${event.ref}\u0000${event.kind}\u0000${event.hash}`;
      if (seen.has(key)) continue;
      seen.add(key);
      events.push(event);
    }
  }
  return events.sort(compareChanges);
}

/**
 * Diffs every project a consumer names and reports what the change reaches. Every problem stays with its own consumer,
 * so one missing bundle never hides another consumer's successful result.
 */
export function previewPropagation(input: PropagationPreviewInput): PropagationPreview {
  const consumers = [...input.manifest.consumers].sort((a, b) => byCodePoint(a.id, b.id));
  const states = new Map<string, ProjectState>();
  const impacts: ConsumerImpact[] = [];
  const unaffected: string[] = [];
  const failures: PropagationFailure[] = [];

  for (const consumer of consumers) {
    const project = consumer.project;
    let state = states.get(project);
    if (state === undefined) {
      const baseline = input.baseline.get(project);
      const current = input.current.get(project);
      if (current === undefined) {
        state = { failure: { project, kind: "missing-bundle", reason: `The current snapshot of "${project}" is not in the lock.` } };
      } else if (baseline === undefined) {
        state = { failure: { project, kind: "missing-bundle", reason: `The baseline snapshot of "${project}" is not in the lock.` } };
      } else if (!isReadable(current.policy, input.allow)) {
        state = { failure: { project, kind: "permission", reason: `The current snapshot of "${project}" is not readable by this caller.` } };
      } else if (!isReadable(baseline.policy, input.allow)) {
        state = { failure: { project, kind: "permission", reason: `The baseline snapshot of "${project}" is not readable by this caller.` } };
      } else {
        state = { events: diffSnapshots(baseline, current) };
      }
      states.set(project, state);
    }
    if ("failure" in state) {
      failures.push({ consumer: consumer.id, ...state.failure });
      continue;
    }
    const baseline = input.baseline.get(project)!;
    const current = input.current.get(project)!;
    const affected = matchChanges(consumer, state.events, current.snapshot.version);
    const impact = impactOf({ consumer, baseline, current, affected });
    if (impact === undefined) unaffected.push(consumer.id);
    else impacts.push(impact);
  }

  return {
    version: 1,
    baseline: identitiesOf(input.baseline),
    current: identitiesOf(input.current),
    events: mergeEvents(states),
    consumers: impacts.sort((a, b) => byCodePoint(a.consumer, b.consumer)),
    unaffected,
    failures,
    partial: failures.length > 0,
  };
}

/** The approvals a consumer's policy accepts, sorted and deduplicated. */
function approvalsFor(consumer: ConsumerDeclaration, principals: readonly string[]): string[] {
  const accepted = principals.filter(
    (principal) => consumer.approval.approvers.includes("*") || consumer.approval.approvers.includes(principal),
  );
  return [...new Set(accepted)].sort(byCodePoint);
}

/** Builds one receipt for an impact that has no earlier receipt. */
function receiptFor(input: {
  readonly consumer: ConsumerDeclaration;
  readonly impact: ConsumerImpact;
  readonly current: SnapshotView;
  readonly receiptId: string;
  readonly approvedBy: readonly string[];
}): { readonly receipt: PropagationReceipt; readonly proposal?: TaskProposal } {
  const { consumer, impact, current, receiptId, approvedBy } = input;
  const changes = distinctChanges(impact.affected);
  const proposal = createsTask(impact.action)
    ? proposeTask({ consumer, current, affected: impact.affected, severity: impact.severity, action: impact.action })
    : undefined;
  const requiresApproval = consumer.approval.mode === "required" && proposal !== undefined;
  const pending = requiresApproval && approvedBy.length === 0;
  let status: PropagationReceiptStatus;
  let reason: string;
  if (pending) {
    status = "pending-approval";
    reason = `Waiting for an approver (${consumer.approval.approvers.join(", ") || "none declared"}).`;
  } else if (proposal === undefined) {
    status = "noop";
    reason = impact.reason;
  } else {
    status = "proposed";
    reason = impact.reason;
  }
  const tasks = pending || proposal === undefined ? [] : [proposal.id];
  const receipt: PropagationReceipt = {
    version: 1,
    id: receiptId,
    consumer: consumer.id,
    upstream: {
      project: current.project,
      snapshot: current.snapshot.id,
      version: current.snapshot.version,
      change: changeSetHash(changes),
    },
    severity: impact.severity,
    action: impact.action,
    status,
    tasks,
    ...(impact.action === "pull-request" && !pending
      ? { pullRequest: `${consumer.id}/${current.project}/${receiptId.slice(0, 12)}` }
      : {}),
    requiresApproval,
    approvedBy,
    reason,
  };
  return { receipt, ...(pending || proposal === undefined ? {} : { proposal }) };
}

/**
 * Applies a preview: every impact gets a receipt, an existing receipt is reused, and only the receipts this run created
 * produce task proposals. Nothing writes the upstream source, and no approval is invented: a consumer whose policy
 * requires one waits with a `pending-approval` receipt until an approver is named.
 */
export function applyPropagation(input: PropagationApplyInput): PropagationApplyResult {
  const preview = previewPropagation(input);
  const byId = new Map(input.manifest.consumers.map((consumer) => [consumer.id, consumer]));
  let ledger = input.ledger;
  const receipts: PropagationReceipt[] = [];
  const tasks: TaskProposal[] = [];
  const reused: string[] = [];
  const created: string[] = [];

  for (const impact of preview.consumers) {
    const consumer = byId.get(impact.consumer);
    const current = input.current.get(impact.project);
    if (consumer === undefined || current === undefined) continue;
    const changes = distinctChanges(impact.affected);
    const receiptId = receiptIdFor(consumer, current, changes);
    const approvedBy = approvalsFor(consumer, input.approvals?.[consumer.id] ?? []);
    const existing = findReceipt(ledger, receiptId);
    if (existing !== undefined) {
      // A pending receipt advances only when this run names an approver its consumer accepts; otherwise it is returned
      // unchanged, so reprocessing the same snapshot never creates another task or pull request.
      const advances = existing.status === "pending-approval" && approvedBy.length > 0;
      if (!advances) {
        receipts.push(existing);
        reused.push(existing.id);
        continue;
      }
      const built = receiptFor({ consumer, impact, current, receiptId, approvedBy });
      ledger = replaceReceipt(ledger, built.receipt);
      receipts.push(built.receipt);
      created.push(built.receipt.id);
      if (built.proposal !== undefined && built.receipt.status !== "pending-approval") tasks.push(built.proposal);
      continue;
    }
    const built = receiptFor({ consumer, impact, current, receiptId, approvedBy });
    ledger = recordReceipt(ledger, built.receipt);
    receipts.push(built.receipt);
    created.push(built.receipt.id);
    if (built.proposal !== undefined && built.receipt.status !== "pending-approval") tasks.push(built.proposal);
  }

  // A consumer that could not be evaluated still gets a durable receipt, keyed by the reason, so a later run finds the
  // same record instead of writing another one. Its successful neighbours are untouched.
  for (const failure of preview.failures) {
    const id = stableHash({
      version: 1,
      kind: "failure",
      consumer: failure.consumer,
      project: failure.project,
      failure: failure.kind,
      reason: failure.reason,
    });
    const existing = findReceipt(ledger, id);
    if (existing !== undefined) {
      receipts.push(existing);
      continue;
    }
    const receipt: PropagationReceipt = {
      version: 1,
      id,
      consumer: failure.consumer,
      upstream: {
        project: failure.project,
        snapshot: "unknown",
        version: "unknown",
        change: stableHash({ failure: failure.kind, reason: failure.reason }),
      },
      severity: "review",
      action: "none",
      status: "failed",
      tasks: [],
      requiresApproval: false,
      approvedBy: [],
      reason: failure.reason,
    };
    ledger = recordReceipt(ledger, receipt);
    receipts.push(receipt);
    created.push(receipt.id);
  }

  return {
    version: 1,
    ledger,
    receipts: receipts.sort((a, b) => byCodePoint(a.id, b.id)),
    tasks,
    reused: reused.sort(byCodePoint),
    created: created.sort(byCodePoint),
    failures: preview.failures,
    partial: preview.partial,
  };
}
