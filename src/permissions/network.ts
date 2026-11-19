/**
 * The network gate: every outbound read asks the policy for an explicit destination and stage, and an approval when
 * the policy requires one. Build, verify, and replay never call this gate because they read only local inputs; the
 * network commands and data fetch call it before the first request.
 */
import type { AccessDecision, AccessGrant, AccessPolicy, AccessStage } from "../contracts/permissions.ts";
import { decideAccess } from "./evaluate.ts";
import { destinationOf } from "./match.ts";
import { redactAccessText } from "./redact.ts";

/** A fetcher with the same shape as the global `fetch`. */
export type GatedFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** What the gate needs besides the URL. */
export interface NetworkGate {
  readonly policy: AccessPolicy;
  readonly task: string;
  readonly snapshot: string;
  readonly stage: AccessStage;
  readonly approvals?: readonly AccessGrant[];
}

/** A refused request: the decision says which rule denied it, never the response body. */
export class AccessNetworkError extends Error {
  readonly code = "network.denied";
  readonly decision: AccessDecision;

  constructor(decision: AccessDecision) {
    super(redactAccessText(`Network access denied (${decision.rule}): ${decision.reason}`));
    this.name = "AccessNetworkError";
    this.decision = decision;
  }
}

/** Decides one URL in one stage. */
export function networkDecision(gate: NetworkGate, url: string): AccessDecision {
  return decideAccess(gate.policy, {
    capability: "network",
    task: gate.task,
    snapshot: gate.snapshot,
    destination: destinationOf(url),
    stage: gate.stage,
    ...(gate.approvals === undefined ? {} : { approvals: gate.approvals }),
  });
}

/**
 * Wraps a fetcher with the policy. A denied request throws {@link AccessNetworkError} before the underlying fetch is
 * called, so a denied destination never receives a connection.
 */
export function gatedFetch(gate: NetworkGate, fetchImpl: GatedFetch): GatedFetch {
  return async (url, init) => {
    const decision = networkDecision(gate, url);
    if (!decision.allowed) throw new AccessNetworkError(decision);
    return fetchImpl(url, init);
  };
}
