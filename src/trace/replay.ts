/**
 * Replay a trace without running anything: same events, same input hashes, same results.
 *
 * Replay is a pure read. It parses the recorded trace, checks that the caller's snapshot is the one
 * the trace was pinned to, and walks the operations in recorded order. It never writes a file, opens
 * a network connection, applies a patch, or calls a model; a replay that cannot reproduce the order
 * or a hash reports the difference instead of acting.
 *
 * Wall-clock time and duration are nondeterministic, so replay never compares them. Comparing a
 * second trace (a replay produced elsewhere) checks task, snapshot, order, stage, kind, capability,
 * input hash, status, result reference, links, and receipts.
 */
import type { TraceDifference, TraceDocument, TraceEvent, TraceParseResult, TraceProblem, TraceReplayResult } from "../contracts/trace.ts";
import { canonicalJson } from "../data/lock.ts";
import { parseTrace } from "./parse.ts";

/** What replay needs besides the trace. */
export interface TraceReplayOptions {
  /** The snapshot the replay must run against; defaults to the recorded one. */
  readonly snapshot?: string;
  /** A second trace to compare with the recorded one, event by event. */
  readonly expect?: unknown;
}

/** Replays one trace, or compares it with a trace another run produced. */
export function replayTrace(value: unknown, options: TraceReplayOptions = {}): TraceReplayResult {
  const parsed: TraceParseResult = parseTrace(value);
  if (parsed.trace === undefined) {
    return { ok: false, snapshot: options.snapshot ?? "", problems: parsed.problems, differences: [], events: 0 };
  }
  const trace = parsed.trace;
  const problems: TraceProblem[] = [];
  if (options.snapshot !== undefined && options.snapshot !== trace.snapshot.id) {
    problems.push({
      path: "/snapshot/id",
      code: "trace.replay-snapshot",
      message: `The trace was recorded against snapshot \`${trace.snapshot.id}\`, not \`${options.snapshot}\`; replay refuses a different input snapshot.`,
    });
  }
  if (problems.length > 0) {
    return { ok: false, snapshot: trace.snapshot.id, problems, differences: [], events: trace.events.length };
  }
  if (options.expect === undefined) {
    return { ok: true, snapshot: trace.snapshot.id, problems: [], differences: [], events: trace.events.length };
  }
  return compareTraces(trace, options.expect);
}

/** Compares a recorded trace with a replay, ignoring timing and cost measurements. */
export function compareTraces(recorded: TraceDocument, replayedValue: unknown): TraceReplayResult {
  const replayed = parseTrace(replayedValue);
  if (replayed.trace === undefined) {
    return {
      ok: false,
      snapshot: recorded.snapshot.id,
      problems: replayed.problems,
      differences: [],
      events: recorded.events.length,
    };
  }
  const after = replayed.trace;
  const differences: TraceDifference[] = [];
  const add = (kind: TraceDifference["kind"], path: string, expected: unknown, actual: unknown): void => {
    differences.push({ kind, path, expected: textOf(expected), actual: textOf(actual) });
  };

  if (recorded.task.id !== after.task.id) add("task", "/task/id", recorded.task.id, after.task.id);
  if (recorded.task.goal !== after.task.goal) add("task", "/task/goal", recorded.task.goal, after.task.goal);
  if (recorded.snapshot.id !== after.snapshot.id) add("snapshot", "/snapshot/id", recorded.snapshot.id, after.snapshot.id);
  if (recorded.events.length !== after.events.length) add("order", "/events", recorded.events.length, after.events.length);

  const length = Math.min(recorded.events.length, after.events.length);
  for (let index = 0; index < length; index += 1) {
    compareEvent(recorded.events[index]!, after.events[index]!, index, add);
  }

  if (recorded.receipts.length !== after.receipts.length) {
    add("receipt", "/receipts", recorded.receipts.length, after.receipts.length);
  }
  const receipts = Math.min(recorded.receipts.length, after.receipts.length);
  for (let index = 0; index < receipts; index += 1) {
    if (recorded.receipts[index]!.id !== after.receipts[index]!.id) {
      add("receipt", `/receipts/${index}`, recorded.receipts[index]!.id, after.receipts[index]!.id);
    }
  }

  return {
    ok: differences.length === 0,
    snapshot: recorded.snapshot.id,
    problems: [],
    differences,
    events: recorded.events.length,
  };
}

/** One event's fields, compared without timing or cost. */
function compareEvent(
  before: TraceEvent,
  after: TraceEvent,
  index: number,
  add: (kind: TraceDifference["kind"], path: string, expected: unknown, actual: unknown) => void,
): void {
  const path = `/events/${index}`;
  const fields = ["sequence", "parent", "stage", "kind", "capability", "status", "inputHash", "result", "file", "subtask", "links"] as const;
  for (const field of fields) {
    const expected = before[field];
    const actual = after[field];
    if (canonicalJson(expected) === canonicalJson(actual)) continue;
    const kind = field === "sequence" || field === "parent" ? "order" : field === "inputHash" ? "hash" : field === "result" ? "result" : "event";
    add(kind, `${path}/${field}`, expected, actual);
  }
}

/** A difference's side as text: a string unchanged, anything else canonical JSON. */
function textOf(value: unknown): string {
  return typeof value === "string" ? value : canonicalJson(value);
}
