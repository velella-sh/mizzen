/**
 * Export the authorized projection of a trace, and nothing else.
 *
 * The export is built field by field, not by deleting from the document, so a field the trace adds
 * later cannot leak by default. Every event keeps its sequence, parent, stage, kind, capability,
 * status, input hash, result reference, links, reason, policy, cost, and timing; it never carries an
 * input or output body, because the contract has none. Free text is redacted again on the way out,
 * and the file name comes only from the two content hashes, never from a local path.
 */
import type { TraceDocument, TraceEvent, TraceExport, TraceLinks, TraceProblem, TraceReceipt, TraceTruncation } from "../contracts/trace.ts";
import { parseTrace } from "./parse.ts";
import { redactText } from "./safe.ts";

/** A trace that cannot be exported; `problems` says why. */
export class TraceExportError extends Error {
  readonly problems: readonly TraceProblem[];

  constructor(problems: readonly TraceProblem[]) {
    super(problems.map((problem) => problem.message).join(" "));
    this.name = "TraceExportError";
    this.problems = problems;
  }
}

/** Exports a trace, refusing anything that does not parse as one. */
export function exportTrace(value: unknown): TraceExport {
  const parsed = parseTrace(value);
  if (parsed.trace === undefined) throw new TraceExportError(parsed.problems);
  const trace = parsed.trace;
  return {
    filename: exportFilename(trace),
    document: {
      version: trace.version,
      id: trace.id,
      task: { id: trace.task.id, goal: redactText(trace.task.goal) },
      snapshot: { ...trace.snapshot },
      events: trace.events.map(exportEvent),
      receipts: trace.receipts.map(exportReceipt),
      nondeterministic: [...trace.nondeterministic],
      ...(trace.truncation === undefined ? {} : { truncation: exportTruncation(trace.truncation) }),
    },
  };
}

/** The file name: both content hashes, nothing else. */
export function exportFilename(trace: TraceDocument): string {
  return `trace-${trace.task.id.slice(0, 12)}-${trace.id.slice(0, 12)}.json`;
}

/** The exported document as text: two-space JSON and one trailing LF. */
export function exportJson(exported: TraceExport): string {
  return `${JSON.stringify(exported.document, null, 2)}\n`;
}

/** One event's authorized fields. */
function exportEvent(event: TraceEvent): TraceEvent {
  return {
    sequence: event.sequence,
    parent: event.parent,
    stage: event.stage,
    kind: event.kind,
    capability: redactText(event.capability),
    status: event.status,
    inputHash: event.inputHash,
    result: event.result,
    ...(event.file === undefined ? {} : { file: event.file }),
    ...(event.subtask === undefined ? {} : { subtask: redactText(event.subtask) }),
    ...(event.links === undefined ? {} : { links: exportLinks(event.links) }),
    ...(event.reason === undefined ? {} : { reason: redactText(event.reason) }),
    ...(event.policy === undefined ? {} : { policy: redactText(event.policy) }),
    ...(event.cost === undefined ? {} : { cost: { ...event.cost } }),
    ...(event.at === undefined ? {} : { at: event.at }),
    ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
  };
}

/** One receipt's authorized fields. */
function exportReceipt(receipt: TraceReceipt): TraceReceipt {
  return { id: receipt.id, kind: receipt.kind, reference: receipt.reference };
}

/** Links, field by field. */
function exportLinks(links: TraceLinks): TraceLinks {
  return {
    ...(links.pack === undefined ? {} : { pack: links.pack }),
    ...(links.patch === undefined ? {} : { patch: links.patch }),
    ...(links.span === undefined ? {} : { span: { ...links.span } }),
    ...(links.transaction === undefined ? {} : { transaction: links.transaction }),
    ...(links.diff === undefined ? {} : { diff: links.diff }),
  };
}

/** The truncation, with its sentence redacted again. */
function exportTruncation(truncation: TraceTruncation): TraceTruncation {
  return {
    droppedEvents: truncation.droppedEvents,
    droppedBytes: truncation.droppedBytes,
    summary: redactText(truncation.summary),
  };
}
