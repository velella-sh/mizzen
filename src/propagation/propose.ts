/**
 * Turn an affected consumer into one task proposal. The proposal states the scope inside the consumer's own tree, the
 * executable acceptance criteria, why the change happened, the decisions that explain it, and only the evidence the
 * consumer's policy authorizes. The upstream source is never named as writable and is never modified.
 */
import type {
  AffectedDependency,
  ConsumerDeclaration,
  ConsumerImpact,
  ProposalDecision,
  ProposalEvidence,
  SemanticChange,
  SnapshotView,
  TaskProposal,
} from "../contracts/propagation.ts";
import type { TaskAcceptanceCriterion } from "../contracts/task.ts";
import { changeSetHash, stableHash, taskProposalIdOf, uniqueSorted } from "./contract.ts";
import { receiptIdFor } from "./impact.ts";
import { distinctChanges } from "./match.ts";

/** True when the consumer's evidence policy permits one id. `deny` wins over `allow`. */
export function evidenceAllowed(id: string, policy: ConsumerDeclaration["evidence"]): boolean {
  const deny = policy.deny ?? [];
  if (deny.includes("*") || deny.includes(id)) return false;
  const allow = policy.allow ?? [];
  return allow.includes("*") || allow.includes(id);
}

/** A decision's link names one of the changed records. */
function decisionExplains(
  record: NonNullable<SnapshotView["decisions"]>[number],
  changes: readonly SemanticChange[],
): boolean {
  for (const link of record.links) {
    for (const change of changes) {
      if (link.kind === "behavior" && change.subject === "behavior" && link.id === change.record) return true;
      if (link.kind === "surface" && change.subject === "surface" && link.id === change.record) return true;
      if (link.kind === "page" && (change.pages ?? []).includes(link.id)) return true;
      if (link.kind === "collection" && change.ref === `collection:${link.id}`) return true;
      if (link.kind === "api" && change.ref === link.id) return true;
    }
  }
  return false;
}

/** The decisions that explain a change set, sorted by id. */
function decisionsOf(changes: readonly SemanticChange[], decisions: NonNullable<SnapshotView["decisions"]>): ProposalDecision[] {
  const found = new Map<string, ProposalDecision>();
  for (const change of changes) {
    if (change.subject !== "decision") continue;
    found.set(change.record, {
      id: change.record,
      reason: `${change.kind === "added" ? "Introduced" : change.kind === "removed" ? "Removed" : "Changed"} ${change.ref}.`,
      ...(change.source === undefined ? {} : { source: change.source }),
    });
  }
  for (const record of decisions) {
    if (found.has(record.id) || !decisionExplains(record, changes)) continue;
    found.set(record.id, {
      id: record.id,
      reason: `The decision links the changed contract: ${record.title}.`,
      source: record.span,
    });
  }
  return [...found.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** One candidate evidence entry before the consumer's policy is applied. */
interface CandidateEvidence {
  readonly id: string;
  readonly project: string;
  readonly kind: string;
  readonly hash?: string;
  readonly url?: string;
}

/** The evidence that names a changed record. */
function candidatesOf(current: SnapshotView, changes: readonly SemanticChange[]): CandidateEvidence[] {
  const evidence = current.evidence;
  if (evidence === undefined) return [];
  const refs = new Set<string>();
  const records = new Set<string>();
  for (const change of changes) {
    refs.add(change.ref);
    records.add(change.record);
    refs.add(`${change.subject}:${change.record}`);
  }
  const claims = evidence.claims.filter(
    (claim) => refs.has(claim.subject) || records.has(claim.subject) || [...refs].some((ref) => ref.endsWith(claim.subject)),
  );
  const claimIds = new Set(claims.map((claim) => claim.id));
  const candidates: CandidateEvidence[] = claims.map((claim) => ({
    id: claim.id,
    project: current.project,
    kind: "claim",
    hash: stableHash(claim),
  }));
  for (const link of evidence.links) {
    const relevant =
      claimIds.has(link.from) ||
      claimIds.has(link.to) ||
      refs.has(link.from) ||
      refs.has(link.to) ||
      records.has(link.from) ||
      records.has(link.to);
    if (!relevant) continue;
    candidates.push({
      id: `${link.from}->${link.to}`,
      project: link.target?.project ?? current.project,
      kind: link.kind,
      hash: link.digest,
    });
  }
  return candidates.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The authorized evidence, and how many candidates the policy withheld. */
export function authorizedEvidence(
  current: SnapshotView,
  changes: readonly SemanticChange[],
  policy: ConsumerDeclaration["evidence"],
): { readonly evidence: readonly ProposalEvidence[]; readonly withheld: number } {
  let withheld = 0;
  const evidence: ProposalEvidence[] = [];
  for (const candidate of candidatesOf(current, changes)) {
    if (!evidenceAllowed(candidate.id, policy)) {
      withheld += 1;
      continue;
    }
    evidence.push({
      id: candidate.id,
      project: candidate.project,
      kind: candidate.kind,
      ...(candidate.hash === undefined ? {} : { hash: candidate.hash }),
      ...(candidate.url === undefined ? {} : { url: candidate.url }),
    });
  }
  return { evidence, withheld };
}

/** Builds the task proposal for one consumer impact. */
export function proposeTask(input: {
  readonly consumer: ConsumerDeclaration;
  readonly current: SnapshotView;
  readonly affected: readonly AffectedDependency[];
  readonly severity: ConsumerImpact["severity"];
  readonly action: ConsumerImpact["action"];
}): TaskProposal {
  const { consumer, current, affected, severity, action } = input;
  const changes = distinctChanges(affected).sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
  const refs = uniqueSorted(changes.map((change) => change.ref));
  const pages = uniqueSorted([
    ...affected.flatMap((entry) => entry.dependency.pages ?? []),
    ...changes.flatMap((change) => change.pages ?? []),
  ]);
  const files = uniqueSorted([
    ...affected.flatMap((entry) => entry.dependency.files ?? []),
    ...changes.flatMap((change) => change.files ?? []),
  ]);
  const symbols = uniqueSorted(
    affected.flatMap((entry) => {
      if (entry.dependency.kind === "symbol") return [entry.dependency.id];
      if (entry.dependency.kind === "surface" && entry.dependency.id.startsWith("symbol:")) {
        return [entry.dependency.id.slice("symbol:".length)];
      }
      return [];
    }),
  );
  const collections = uniqueSorted(
    affected.flatMap((entry) => {
      if (entry.dependency.kind === "collection") return [entry.dependency.id];
      if (entry.dependency.kind === "surface" && entry.dependency.id.startsWith("collection:")) {
        return [entry.dependency.id.slice("collection:".length)];
      }
      return [];
    }),
  );
  const decisions = decisionsOf(changes, current.decisions ?? []);
  const authorized = authorizedEvidence(current, changes, consumer.evidence);
  const receiptId = receiptIdFor(consumer, current, changes);
  const goal = `Update ${consumer.id} for ${current.project} ${current.snapshot.version}: ${refs.join(", ")}.`;
  const acceptance: TaskAcceptanceCriterion[] = [
    {
      id: "reflect-change",
      statement: pages.length > 0
        ? `The consumer pages ${pages.join(", ")} reflect ${refs.join(", ")}.`
        : `The consumer reflects ${refs.join(", ")}.`,
      check: "site-check",
    },
    ...(severity === "breaking"
      ? [{ id: "consumer-checks", statement: "The consumer's checks pass against the new snapshot.", check: "consumer-checks" }]
      : []),
    ...(severity === "review"
      ? [{ id: "review-change", statement: "A reviewer confirms the consumer still satisfies the changed contract.", review: true as const }]
      : []),
  ];
  return {
    version: 1,
    id: taskProposalIdOf(receiptId, consumer.id),
    consumer: consumer.id,
    upstream: {
      project: current.project,
      snapshot: current.snapshot.id,
      version: current.snapshot.version,
      change: changeSetHash(changes),
    },
    severity,
    action,
    goal,
    scope: { pages, blocks: [], collections, symbols, files },
    acceptance,
    rationale: `${consumer.id} declares ${refs.join(", ")}; ${current.project} ${current.snapshot.version} changed them and the policy classifies the change ${severity}.`,
    decisions,
    evidence: authorized.evidence,
    withheldEvidence: authorized.withheld,
    changes: changes.map((change) => ({ ref: change.ref, hash: change.hash })),
  };
}
