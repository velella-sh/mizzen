/**
 * The recorder: turn calls into ordered trace events without ever keeping their bodies.
 *
 * A caller names the capability, the stage, the status, and the input value. The recorder hashes the
 * canonical input, refuses a private-reasoning key, validates every reference, and appends one event
 * whose parent defaults to the previous event. A decision, refusal, or approval without a reason and
 * a policy is refused at the call that tried to record it, so a malformed trace cannot be written in
 * the first place.
 *
 * The recorder reads a clock only when the caller supplies one; a default recorder writes no wall
 * time, so its output is byte-identical across runs.
 */
import type { TaskSnapshot } from "../contracts/task.ts";
import type {
  TraceCost,
  TraceDocument,
  TraceEvent,
  TraceEventKind,
  TraceEventStatus,
  TraceLinks,
  TraceProblem,
  TraceReceipt,
  TraceReceiptKind,
  TraceStage,
  TraceTask,
} from "../contracts/trace.ts";
import { parseTrace, TRACE_VERSION } from "./parse.ts";
import {
  hasPrivateReasoning,
  inputHashOf,
  receiptIdOf,
  redactText,
  referenceProblem,
} from "./safe.ts";

/** One call to record. */
export interface TraceAppendRequest {
  readonly stage: TraceStage;
  readonly kind: TraceEventKind;
  readonly capability: string;
  readonly status: TraceEventStatus;
  /** The value to hash; it is never stored. */
  readonly input?: unknown;
  /** A safe reference to the result, or `null` when the call produced none. */
  readonly result?: string | null;
  /** The source file, site-relative. */
  readonly file?: string;
  readonly subtask?: string;
  readonly links?: TraceLinks;
  /** Required for a decision, refusal, or approval. */
  readonly reason?: string;
  /** Required for a decision, refusal, or approval. */
  readonly policy?: string;
  readonly cost?: TraceCost;
  /** A parent sequence; defaults to the previous event. */
  readonly parent?: number;
  /** Elapsed milliseconds; recorded as a nondeterministic measurement. */
  readonly durationMs?: number;
}

/** What {@link TraceRecorder} needs. */
export interface TraceRecorderOptions {
  readonly task: TraceTask;
  readonly snapshot: TaskSnapshot;
  /** A clock for wall time; absent means no `at` is ever written. */
  readonly now?: () => string;
}

/** A call the recorder refused; `problems` says why. */
export class TraceRecordError extends Error {
  readonly problems: readonly TraceProblem[];

  constructor(problems: readonly TraceProblem[]) {
    super(problems.map((problem) => problem.message).join(" "));
    this.name = "TraceRecordError";
    this.problems = problems;
  }
}

/** The decision kinds that must carry a reason and a policy. */
const DECISION_KINDS: readonly TraceEventKind[] = ["decision", "refusal", "approval"];

/** Appends safe events to one trace. */
export class TraceRecorder {
  readonly task: TraceTask;
  readonly snapshot: TaskSnapshot;
  private readonly now: (() => string) | undefined;
  private readonly events: TraceEvent[] = [];
  private readonly receipts: TraceReceipt[] = [];

  constructor(options: TraceRecorderOptions) {
    this.task = { id: options.task.id, goal: redactText(options.task.goal.trim()) };
    this.snapshot = { ...options.snapshot };
    this.now = options.now;
  }

  /** Appends one event, or throws {@link TraceRecordError} without changing the trace. */
  append(request: TraceAppendRequest): TraceEvent {
    const problems: TraceProblem[] = [];
    const sequence = this.events.length;
    const parent = request.parent ?? (sequence === 0 ? null : sequence - 1);

    if (parent !== null && (parent < 0 || parent >= sequence)) {
      problems.push({
        path: `/events/${sequence}/parent`,
        code: "trace.parent",
        message: `The parent must be an earlier event, or null for the first one; found ${parent}.`,
      });
    }
    if (sequence === 0 && parent !== null) {
      problems.push({
        path: "/events/0/parent",
        code: "trace.parent",
        message: "The first event is the root and must have `parent: null`.",
      });
    }
    if (request.capability.trim() === "") {
      problems.push({ path: `/events/${sequence}/capability`, code: "trace.capability", message: "A capability cannot be empty." });
    }
    if (hasPrivateReasoning(request)) {
      problems.push({
        path: `/events/${sequence}`,
        code: "trace.private-reasoning",
        message: "Record a decision and its reason, never private model reasoning or chain of thought.",
      });
    }
    if (request.result !== undefined && request.result !== null) {
      const problem = referenceProblem(request.result);
      if (problem !== undefined) {
        problems.push({ path: `/events/${sequence}/result`, code: "trace.reference", message: `The result ${problem}.` });
      }
    }
    if (request.file !== undefined) {
      const problem = referenceProblem(request.file);
      if (problem !== undefined) {
        problems.push({ path: `/events/${sequence}/file`, code: "trace.path", message: `The file ${problem}.` });
      }
    }
    for (const key of ["pack", "patch", "transaction", "diff"] as const) {
      const value = request.links?.[key];
      if (value === undefined) continue;
      const problem = referenceProblem(value);
      if (problem !== undefined) {
        problems.push({ path: `/events/${sequence}/links/${key}`, code: "trace.reference", message: `The link ${problem}.` });
      }
    }
    if (DECISION_KINDS.includes(request.kind)) {
      if (request.reason === undefined || request.reason.trim() === "") {
        problems.push({
          path: `/events/${sequence}/reason`,
          code: "trace.reason",
          message: `A \`${request.kind}\` event needs a reason.`,
        });
      }
      if (request.policy === undefined || request.policy.trim() === "") {
        problems.push({
          path: `/events/${sequence}/policy`,
          code: "trace.policy",
          message: `A \`${request.kind}\` event needs a policy reference.`,
        });
      }
    }
    const costProblem = costProblems(request.cost, `/events/${sequence}/cost`);
    if (costProblem !== undefined) problems.push(costProblem);
    if (request.durationMs !== undefined && (!Number.isInteger(request.durationMs) || request.durationMs < 0)) {
      problems.push({
        path: `/events/${sequence}/durationMs`,
        code: "trace.duration",
        message: "A duration is a non-negative whole number of milliseconds.",
      });
    }

    if (problems.length > 0) throw new TraceRecordError(problems);

    const at = this.now?.();
    const event: TraceEvent = {
      sequence,
      parent,
      stage: request.stage,
      kind: request.kind,
      capability: redactText(request.capability.trim()),
      status: request.status,
      inputHash: inputHashOf(request.input ?? null),
      result: request.result ?? null,
      ...(request.file === undefined ? {} : { file: request.file }),
      ...(request.subtask === undefined ? {} : { subtask: redactText(request.subtask.trim()) }),
      ...(request.links === undefined ? {} : { links: { ...request.links } }),
      ...(request.reason === undefined ? {} : { reason: redactText(request.reason.trim()) }),
      ...(request.policy === undefined ? {} : { policy: redactText(request.policy.trim()) }),
      ...(request.cost === undefined ? {} : { cost: { ...request.cost } }),
      ...(at === undefined ? {} : { at }),
      ...(request.durationMs === undefined ? {} : { durationMs: request.durationMs }),
    };
    this.events.push(event);
    return event;
  }

  /** Adds one receipt; the id is derived, and the same kind and reference is refused twice. */
  receipt(kind: TraceReceiptKind, reference: string): TraceReceipt {
    const problem = referenceProblem(reference);
    if (problem !== undefined) {
      throw new TraceRecordError([{ path: "/receipts", code: "trace.reference", message: `The receipt ${problem}.` }]);
    }
    const id = receiptIdOf(kind, reference);
    if (this.receipts.some((receipt) => receipt.id === id)) {
      throw new TraceRecordError([{ path: "/receipts", code: "trace.receipt-duplicate", message: "That receipt is already recorded." }]);
    }
    const receipt: TraceReceipt = { id, kind, reference };
    this.receipts.push(receipt);
    return receipt;
  }

  /** The finished, validated document. */
  document(): TraceDocument {
    const parsed = parseTrace({
      version: TRACE_VERSION,
      task: this.task,
      snapshot: this.snapshot,
      events: this.events,
      receipts: this.receipts,
    });
    if (parsed.trace === undefined) throw new TraceRecordError(parsed.problems);
    return parsed.trace;
  }
}

/** One cost problem, or `undefined` when the cost is three non-negative whole numbers. */
export function costProblems(cost: TraceCost | undefined, path: string): TraceProblem | undefined {
  if (cost === undefined) return undefined;
  for (const key of ["contextTokens", "refillTokens", "toolCalls"] as const) {
    const value = cost[key];
    if (!Number.isInteger(value) || value < 0) {
      return { path: `${path}/${key}`, code: "trace.cost", message: `\`${key}\` must be a non-negative whole number.` };
    }
  }
  return undefined;
}
