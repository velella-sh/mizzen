/**
 * The pure primitives every propagation module shares: stable hashing, code-point ordering, the severity order, and the
 * deterministic ids a proposal and a receipt use. Nothing here reads a clock, the environment, or a local path.
 */
import type {
  ChangeSeverity,
  ConsumerVersionPolicy,
  PropagationAction,
  SemanticChange,
  SnapshotIdentity,
  TaskProposal,
} from "../contracts/propagation.ts";
import { canonicalJson, sha256 } from "../data/lock.ts";

/** Compares strings by code point, never by locale. */
export function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** SHA-256 over the canonical body of a value. */
export function stableHash(value: unknown): string {
  return sha256(canonicalJson(value));
}

/** The distinct values of a list, sorted by code point. */
export function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(byCodePoint);
}

/** The severity order, from weakest to strongest. */
const SEVERITY_RANK: Readonly<Record<ChangeSeverity, number>> = { compatible: 0, review: 1, breaking: 2 };

/** The stronger of two severities. */
export function strongerSeverity(a: ChangeSeverity, b: ChangeSeverity): ChangeSeverity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

/** The action a consumer's policy asks for at one severity, with the documented defaults. */
export function actionFor(policy: ConsumerVersionPolicy, severity: ChangeSeverity): PropagationAction {
  if (severity === "breaking") return policy.onBreaking ?? "task";
  if (severity === "review") return policy.onReview ?? "review";
  return policy.onCompatible ?? "acknowledge";
}

/** The identity part of a snapshot, without its data. */
export function identityOf(snapshot: SnapshotIdentity): SnapshotIdentity {
  return { project: snapshot.project, namespace: snapshot.namespace, snapshot: snapshot.snapshot };
}

/** The stable id a consumer declares for a change: `api:greet`, `behavior:install.runs`, `decision:ADR-0001`. */
export function refOf(subject: SemanticChange["subject"], record: string): string {
  return `${subject}:${record}`;
}

/** SHA-256 over a change set, independent of the order the events were collected in. */
export function changeSetHash(events: readonly SemanticChange[]): string {
  return stableHash([...events].sort(compareChanges));
}

/** The stable order a preview lists changes in. */
export function compareChanges(a: SemanticChange, b: SemanticChange): number {
  return (
    byCodePoint(a.project, b.project) ||
    byCodePoint(a.subject, b.subject) ||
    byCodePoint(a.ref, b.ref) ||
    byCodePoint(a.kind, b.kind) ||
    byCodePoint(a.hash, b.hash)
  );
}

/** The id a proposal and its receipt share: consumer, upstream snapshot, and change set, with no clock. */
export function propagationIdOf(
  consumer: string,
  upstream: SnapshotIdentity["snapshot"] & { readonly project: string },
  events: readonly SemanticChange[],
): string {
  return sha256(
    canonicalJson({
      version: 1,
      consumer,
      upstream: { project: upstream.project, snapshot: upstream.id, version: upstream.version },
      changes: changeSetHash(events),
    }),
  );
}

/** A deterministic task proposal id: the proposal id is the receipt id, so a reprocessed change keeps one task. */
export function taskProposalIdOf(receiptId: string, consumer: string): string {
  return sha256(canonicalJson({ version: 1, kind: "task", receipt: receiptId, consumer }));
}

/** The sorted change summary a proposal carries. */
export function proposalChangesOf(events: readonly SemanticChange[]): TaskProposal["changes"] {
  return [...events]
    .sort(compareChanges)
    .map((event) => ({ ref: event.ref, hash: event.hash }));
}
