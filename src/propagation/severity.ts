/**
 * Change severity against a consumer's declared version policy. A removal is breaking, a new item is compatible, and a
 * signature, status, link, digest, or scope change needs review. A snapshot outside the consumer's range is breaking
 * whatever the shape of the change, so a consumer is never asked to accept a version it did not declare.
 */
import type { ChangeSeverity, ConsumerVersionPolicy, SemanticChange } from "../contracts/propagation.ts";
import { versionInRange } from "../federation/contract.ts";
import { strongerSeverity } from "./contract.ts";

/** The severity of one change's shape, before the version policy is applied. */
export function severityOfChange(change: SemanticChange): ChangeSeverity {
  if (change.kind === "removed") return "breaking";
  if (change.kind === "added") return "compatible";
  return "review";
}

/** True when the consumer's policy accepts `version`. An absent range accepts the locked snapshot. */
export function acceptsVersion(policy: ConsumerVersionPolicy, version: string): boolean {
  if (policy.range === undefined) return true;
  return versionInRange(version, policy.range);
}

/** The severity of one change for one consumer at one snapshot version. */
export function severityFor(change: SemanticChange, policy: ConsumerVersionPolicy, version: string): ChangeSeverity {
  if (!acceptsVersion(policy, version)) return "breaking";
  return severityOfChange(change);
}

/** The strongest severity in a list, or `compatible` for an empty one. */
export function overallSeverity(severities: readonly ChangeSeverity[]): ChangeSeverity {
  return severities.reduce<ChangeSeverity>((strongest, severity) => strongerSeverity(strongest, severity), "compatible");
}
