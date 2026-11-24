/**
 * Reading a locked snapshot and deciding who may see it. A snapshot view is built from a verified `KnowledgeBundle`
 * and an optional public decision list; nothing is reread from disk here. A bundle the caller is not authorized to
 * read is refused before any of its data is used.
 */
import type {
  DecisionRecord,
} from "../contracts/decisions.ts";
import type { KnowledgeBundle } from "../contracts/federation.ts";
import type { SnapshotIdentity, SnapshotPolicy, SnapshotView } from "../contracts/propagation.ts";

/** True when `allow` may read a snapshot with `policy`. A public snapshot is readable by anyone. */
export function isReadable(policy: SnapshotPolicy, allow: readonly string[] | undefined): boolean {
  if (policy.public) return true;
  if (allow === undefined) return false;
  return policy.audiences.every((audience) => allow.includes(audience));
}

/** The snapshot identity without its data. */
export function identityOfSnapshot(snapshot: SnapshotIdentity): SnapshotIdentity {
  return { project: snapshot.project, namespace: snapshot.namespace, snapshot: snapshot.snapshot };
}

/** Builds a snapshot view from a verified bundle, with an optional list of public decision records. */
export function snapshotOfBundle(
  bundle: KnowledgeBundle,
  decisions?: readonly DecisionRecord[],
): SnapshotView {
  return {
    project: bundle.project,
    namespace: bundle.namespace,
    snapshot: bundle.snapshot,
    policy: bundle.policy,
    graph: bundle.graph,
    surface: bundle.surface,
    behaviors: bundle.behaviors,
    ...(decisions === undefined || decisions.length === 0 ? {} : { decisions }),
    evidence: bundle.evidence,
  };
}
