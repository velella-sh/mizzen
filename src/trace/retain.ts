/**
 * Bound a trace by events and bytes, keeping what proves the work.
 *
 * When a trace is larger than its limits, the root event, every decision, refusal, and approval,
 * every event a receipt points at, every linked edit, and the final state stay. Other events are
 * dropped from the end until both limits hold; a kept event whose parent was dropped is re-parented
 * to its nearest kept ancestor, so the sequence stays contiguous and every parent still points
 * backwards. The result carries an honest truncation summary with the dropped count and bytes.
 *
 * If the proof-critical events alone exceed a limit, they are kept anyway and the summary says so:
 * losing the evidence would make the trace smaller and useless.
 */
import type { TraceBound, TraceDocument, TraceEvent, TraceTruncation } from "../contracts/trace.ts";
import { canonicalJson } from "../data/lock.ts";
import { parseTrace } from "./parse.ts";

/** The caps a bounded trace enforces. */
export interface TraceLimits {
  /** Most events the trace may keep. */
  readonly maxEvents: number;
  /** Most bytes of canonical event JSON the trace may keep. */
  readonly maxBytes: number;
}

/** The default caps: enough for a long agent run, small enough to open and hand off. */
export const DEFAULT_TRACE_LIMITS: TraceLimits = { maxEvents: 500, maxBytes: 262_144 };

/** One kept event and its original position. */
interface Kept {
  readonly event: TraceEvent;
  readonly oldIndex: number;
}

/** Bounds a valid trace; returns it unchanged when it already fits. */
export function boundTrace(trace: TraceDocument, limits: Partial<TraceLimits> = {}): TraceBound {
  const maxEvents = limits.maxEvents ?? DEFAULT_TRACE_LIMITS.maxEvents;
  const maxBytes = limits.maxBytes ?? DEFAULT_TRACE_LIMITS.maxBytes;
  if (trace.events.length <= maxEvents && eventBytes(trace.events) <= maxBytes) {
    return { trace };
  }

  const last = trace.events.length - 1;
  const receiptRefs = new Set(trace.receipts.map((receipt) => receipt.reference));
  const critical = (event: TraceEvent, index: number): boolean =>
    index === 0 ||
    index === last ||
    event.kind === "decision" ||
    event.kind === "refusal" ||
    event.kind === "approval" ||
    event.links?.patch !== undefined ||
    event.links?.diff !== undefined ||
    (event.result !== null && receiptRefs.has(event.result));

  const keep = new Set<number>();
  trace.events.forEach((event, index) => {
    if (critical(event, index)) keep.add(index);
  });
  for (let index = 0; index < trace.events.length && keep.size < maxEvents; index += 1) {
    if (!critical(trace.events[index]!, index)) keep.add(index);
  }
  while (keep.size > maxEvents) {
    const droppable = [...keep].filter((index) => !critical(trace.events[index]!, index)).sort((a, b) => b - a);
    const drop = droppable[0];
    if (drop === undefined) break;
    keep.delete(drop);
  }

  while (eventBytes([...keep].sort((a, b) => a - b).map((index) => trace.events[index]!)) > maxBytes) {
    const droppable = [...keep].filter((index) => !critical(trace.events[index]!, index)).sort((a, b) => b - a);
    const drop = droppable[0];
    if (drop === undefined) break;
    keep.delete(drop);
  }

  const kept = rebuild(trace.events, keep);

  const keptIndexes = new Set(kept.map((entry) => entry.oldIndex));
  const dropped = trace.events.filter((_event, index) => !keptIndexes.has(index));
  if (dropped.length === 0) {
    // Every event is proof-critical; a truncation record with nothing dropped would be a lie.
    return { trace };
  }
  const droppedBytes = eventBytes(dropped);
  const proofKept = trace.events.filter((event, index) => critical(event, index)).length;
  const overLimit = kept.length >= maxEvents || eventBytes(kept.map((entry) => entry.event)) > maxBytes;
  const summary = truncationSummary({
    kept: kept.length,
    total: trace.events.length,
    dropped: dropped.length,
    droppedBytes,
    maxEvents,
    maxBytes,
    proofKept,
    overLimit,
  });

  const raw = {
    version: trace.version,
    task: trace.task,
    snapshot: trace.snapshot,
    events: kept.map((entry) => entry.event),
    receipts: trace.receipts,
    truncation: { droppedEvents: dropped.length, droppedBytes, summary },
  };
  const parsed = parseTrace(raw);
  if (parsed.trace === undefined) {
    // The rebuild preserves every invariant; reaching here means the input was not a parsed trace.
    throw new Error(`bounded trace did not parse: ${parsed.problems.map((problem) => problem.message).join(" ")}`);
  }
  return parsed.trace.truncation === undefined
    ? { trace: parsed.trace }
    : { trace: parsed.trace, truncation: parsed.trace.truncation };
}

/** The kept events, re-sequenced with parents re-pointed at the nearest kept ancestor. */
function rebuild(events: readonly TraceEvent[], keep: ReadonlySet<number>): Kept[] {
  const kept: Kept[] = [];
  const sequenceOf = new Map<number, number>();
  for (const index of [...keep].sort((a, b) => a - b)) {
    sequenceOf.set(index, kept.length);
    kept.push({ event: events[index]!, oldIndex: index });
  }

  return kept.map(({ event, oldIndex }) => {
    let parent = oldIndex === 0 ? null : event.parent;
    while (parent !== null && !keep.has(parent)) parent = events[parent]?.parent ?? null;
    const sequence = sequenceOf.get(oldIndex)!;
    const parentSequence = parent === null ? null : sequenceOf.get(parent) ?? (sequence > 0 ? 0 : null);
    return {
      oldIndex,
      event: {
        ...event,
        sequence,
        parent: sequence === 0 ? null : parentSequence ?? 0,
      },
    };
  });
}

/** The canonical JSON bytes one event list occupies. */
function eventBytes(events: readonly TraceEvent[]): number {
  return Buffer.byteLength(canonicalJson(events), "utf8");
}

/** The honest sentence a bounded trace carries. */
function truncationSummary(input: {
  readonly kept: number;
  readonly total: number;
  readonly dropped: number;
  readonly droppedBytes: number;
  readonly maxEvents: number;
  readonly maxBytes: number;
  readonly proofKept: number;
  readonly overLimit: boolean;
}): string {
  const base = `Kept ${input.kept} of ${input.total} events (${input.dropped} dropped, ${input.droppedBytes} bytes) within ${input.maxEvents} events and ${input.maxBytes} bytes; the root, decisions, receipts, linked edits, and final state were kept.`;
  return input.overLimit
    ? `${base} The ${input.proofKept} proof-critical events alone exceed a limit and were kept, because dropping them would remove the evidence.`
    : base;
}
