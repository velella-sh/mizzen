/**
 * Hand work from one agent to the next using only the trace.
 *
 * The handoff names the task and snapshot, the status the run stopped at, the receipts that point at
 * real changes, every decision with its reason and policy, and the calls that failed, were refused,
 * or were skipped. It is deliberately small: a new agent reads it plus the receipts and knows what
 * was done, why, and what is left, without the previous conversation.
 */
import type {
  TraceDocument,
  TraceEventKind,
  TraceEventStatus,
  TraceHandoff,
  TraceReceipt,
} from "../contracts/trace.ts";

/** The receipt kinds that name a change to read or verify. */
const CHANGE_KINDS: readonly TraceReceipt["kind"][] = ["patch", "proof", "diff"];

/** Builds the handoff from a valid trace. */
export function handoffOf(trace: TraceDocument): TraceHandoff {
  const last = trace.events[trace.events.length - 1]!;
  return {
    task: trace.task,
    snapshot: trace.snapshot.id,
    state: last.status,
    changes: trace.receipts.filter((receipt) => CHANGE_KINDS.includes(receipt.kind)),
    decisions: trace.events
      .filter((event) => isDecision(event.kind))
      .map((event) => ({
        sequence: event.sequence,
        kind: event.kind,
        reason: event.reason ?? "",
        policy: event.policy ?? "",
      })),
    remaining: trace.events
      .filter((event) => event.status !== "ok")
      .map((event) => ({
        sequence: event.sequence,
        capability: event.capability,
        status: event.status as Exclude<TraceEventStatus, "ok">,
        ...(event.reason === undefined ? {} : { reason: event.reason }),
      })),
    receipts: trace.receipts,
    ...(trace.truncation === undefined ? {} : { truncation: trace.truncation }),
  };
}

/** True for the kinds that record a decision, refusal, or approval. */
function isDecision(kind: TraceEventKind): boolean {
  return kind === "decision" || kind === "refusal" || kind === "approval";
}
