/**
 * Search and summarise a trace.
 *
 * A filter names a stage, a file, a task, a status, or any combination; an absent field does not
 * filter. Task matches an exact task id or a case-insensitive part of the goal. Summaries count
 * events per stage and per status and list every result and receipt reference in first-appearance
 * order, so a summary always links back to the evidence the trace names.
 */
import type {
  TraceDocument,
  TraceEvent,
  TraceEventStatus,
  TraceFilter,
  TraceStage,
  TraceStageCount,
  TraceStatusCount,
  TraceSummary,
} from "../contracts/trace.ts";

/** Every stage, in the order the summary lists them. */
export const TRACE_STAGES: readonly TraceStage[] = ["context", "edit", "verify", "decision", "handoff"];

/** Every status, in the order the summary lists them. */
export const TRACE_STATUSES: readonly TraceEventStatus[] = ["ok", "failed", "refused", "skipped"];

/** True when the trace itself matches a task filter. */
export function matchesTask(trace: TraceDocument, task: string): boolean {
  const term = task.trim().toLowerCase();
  return term !== "" && (trace.task.id === task.trim() || trace.task.goal.toLowerCase().includes(term));
}

/** True when one event matches every field of the filter. */
export function matchesEvent(trace: TraceDocument, event: TraceEvent, filter: TraceFilter): boolean {
  if (filter.stage !== undefined && event.stage !== filter.stage) return false;
  if (filter.file !== undefined && event.file !== filter.file) return false;
  if (filter.status !== undefined && event.status !== filter.status) return false;
  if (filter.task !== undefined && !matchesTask(trace, filter.task)) return false;
  return true;
}

/** The events that match, in trace order. */
export function searchTrace(trace: TraceDocument, filter: TraceFilter = {}): readonly TraceEvent[] {
  return trace.events.filter((event) => matchesEvent(trace, event, filter));
}

/** A trace at a glance, with every evidence reference the trace names. */
export function summaryOf(trace: TraceDocument): TraceSummary {
  const stages = TRACE_STAGES.map((stage) => ({ stage, events: trace.events.filter((event) => event.stage === stage).length }));
  const statuses = TRACE_STATUSES.map((status) => ({ status, events: trace.events.filter((event) => event.status === status).length }));

  const evidence: string[] = [];
  const seen = new Set<string>();
  const add = (reference: string): void => {
    if (seen.has(reference)) return;
    seen.add(reference);
    evidence.push(reference);
  };
  for (const event of trace.events) if (event.result !== null) add(event.result);
  for (const receipt of trace.receipts) add(receipt.reference);

  return {
    id: trace.id,
    task: trace.task,
    snapshot: trace.snapshot.id,
    events: trace.events.length,
    receipts: trace.receipts.length,
    stages,
    statuses,
    evidence,
    ...(trace.truncation === undefined ? {} : { truncation: trace.truncation }),
  };
}

/** The summary counts with zero rows left in, so a printed summary has no noise. */
export function compactSummary(summary: TraceSummary): TraceSummary {
  return {
    ...summary,
    stages: summary.stages.filter((row: TraceStageCount) => row.events > 0),
    statuses: summary.statuses.filter((row: TraceStatusCount) => row.events > 0),
  };
}
