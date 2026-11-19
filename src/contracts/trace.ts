/**
 * One versioned agent trace: the task it ran for, the snapshot it ran against, the ordered events,
 * the safe inputs and result references, and the receipts that point at the evidence on disk.
 *
 * A trace never stores an input or an output body. An event keeps the SHA-256 of its canonical
 * input and a reference to its result, so the same trace names what happened without disclosing
 * content, credentials, or machine-local paths. Thinking, reasoning, and chain-of-thought fields are
 * not part of this contract and are refused by the recorder.
 *
 * Wall-clock time and duration are measurements, not facts: the parser lists every one of them in
 * {@link TraceDocument.nondeterministic}, and replay compares events, input hashes, and results
 * only. Receipts and the trace id are derived from content, so two runs over the same events give
 * the same bytes.
 */
import type { TaskSnapshot } from "./task.ts";

/** The only trace version. */
export type TraceVersion = 1;

/** The stage of a run an event belongs to. */
export type TraceStage = "context" | "edit" | "verify" | "decision" | "handoff";

/** What an event records. Decision, refusal, and approval carry a reason and a policy reference. */
export type TraceEventKind =
  | "context"
  | "tool"
  | "edit"
  | "verify"
  | "decision"
  | "refusal"
  | "approval";

/** How an event ended. */
export type TraceEventStatus = "ok" | "failed" | "refused" | "skipped";

/** The task a trace belongs to; the goal is the only prose it keeps. */
export interface TraceTask {
  /** SHA-256 of the task's idempotency key, from `taskIdOf`. */
  readonly id: string;
  /** The task in one sentence. */
  readonly goal: string;
}

/** One source span, 1-based lines and columns, the end inclusive. */
export interface TraceSpan {
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
}

/** What a context, edit, or verification event points at. Every field is a safe reference or hash. */
export interface TraceLinks {
  /** The pack id or content hash the context came from. */
  readonly pack?: string;
  /** The SHA-256 of the patch document that was applied. */
  readonly patch?: string;
  /** The source span the edit touched. */
  readonly span?: TraceSpan;
  /** The transaction id that committed the change. */
  readonly transaction?: string;
  /** The SHA-256 of the unified diff; the trace's way to the actual change. */
  readonly diff?: string;
}

/** Tokens and calls one subtask spent. */
export interface TraceCost {
  /** Estimated context tokens carried into the subtask. */
  readonly contextTokens: number;
  /** Estimated tokens spent refilling context during the subtask. */
  readonly refillTokens: number;
  /** Tool calls the subtask made. */
  readonly toolCalls: number;
}

/** One event in a trace. Bodies are hashes and references; never content. */
export interface TraceEvent {
  /** Zero-based position in the trace, without gaps. */
  readonly sequence: number;
  /** The sequence of the event this one descends from; `null` for the first event only. */
  readonly parent: number | null;
  /** The stage of the run. */
  readonly stage: TraceStage;
  /** What the event records. */
  readonly kind: TraceEventKind;
  /** The MCP tool or CLI command, such as `edit.apply` or `pack`. */
  readonly capability: string;
  /** How the call ended. */
  readonly status: TraceEventStatus;
  /** SHA-256 of the canonical input. The input itself is never stored. */
  readonly inputHash: string;
  /** A safe reference to the result, or `null` when the call produced none. */
  readonly result: string | null;
  /** The source file, relative to the site root, with forward slashes. */
  readonly file?: string;
  /** The subtask the event belongs to, such as `install-guide`. */
  readonly subtask?: string;
  /** What the event points at. */
  readonly links?: TraceLinks;
  /** Why a decision, refusal, or approval happened; required for those kinds. */
  readonly reason?: string;
  /** The policy that required or allowed it; required for decisions, refusals, and approvals. */
  readonly policy?: string;
  /** What the subtask spent. */
  readonly cost?: TraceCost;
  /** Wall-clock time, ISO 8601 UTC. Nondeterministic. */
  readonly at?: string;
  /** Elapsed milliseconds. Nondeterministic. */
  readonly durationMs?: number;
}

/** What a receipt points at, which decides whether the handoff lists it as a change or as proof. */
export type TraceReceiptKind = "pack" | "patch" | "proof" | "verification" | "diff";

/** One result the caller can open. `id` is derived from the kind and reference. */
export interface TraceReceipt {
  /** SHA-256 over the kind and reference; computed by the parser, never guessed. */
  readonly id: string;
  /** What the receipt points at. */
  readonly kind: TraceReceiptKind;
  /** A site-relative path, a content hash, or a URL without credentials. */
  readonly reference: string;
}

/** What a bounded trace dropped, and a sentence that says so. */
export interface TraceTruncation {
  /** How many events were left out. */
  readonly droppedEvents: number;
  /** How many bytes of canonical event JSON were left out. */
  readonly droppedBytes: number;
  /** One sentence naming what was dropped and what was kept. */
  readonly summary: string;
}

/** One trace document, as written to disk. */
export interface TraceDocument {
  /** The format version, always 1. */
  readonly version: TraceVersion;
  /** SHA-256 over the task, snapshot, events, receipts, and truncation. */
  readonly id: string;
  /** The task the trace belongs to. */
  readonly task: TraceTask;
  /** The input snapshot the run was pinned to. */
  readonly snapshot: TaskSnapshot;
  /** The ordered events, starting with the one whose parent is `null`. */
  readonly events: readonly TraceEvent[];
  /** The results the trace can hand to another agent, in caller order. */
  readonly receipts: readonly TraceReceipt[];
  /** JSON Pointers to every wall-clock or duration value; replay ignores them. */
  readonly nondeterministic: readonly string[];
  /** Present when the trace was bounded; says exactly what is missing. */
  readonly truncation?: TraceTruncation;
}

/** One reason a trace was refused. */
export interface TraceProblem {
  /** JSON Pointer to the offending value, such as `/events/2/parent`; `""` is the whole document. */
  readonly path: string;
  /** Stable identifier, such as `trace.parent`. */
  readonly code: string;
  /** What is wrong and what to write instead, in one sentence. */
  readonly message: string;
}

/** The result of parsing a trace. */
export interface TraceParseResult {
  /** The validated trace; present exactly when `problems` is empty. */
  readonly trace?: TraceDocument;
  /** Every problem found, in document order. */
  readonly problems: readonly TraceProblem[];
}

/** What one subtask spent, over every event that names it. */
export interface TraceSubtaskCost extends TraceCost {
  /** The subtask name, or `unassigned` for events that name none. */
  readonly subtask: string;
}

/** The usage a trace accounts for. */
export interface TraceUsage {
  /** One row per subtask, in first-appearance order. */
  readonly subtasks: readonly TraceSubtaskCost[];
  /** Every subtask added up. */
  readonly total: TraceCost;
  /** Every recorded duration added up; nondeterministic. */
  readonly timeMs: number;
  /** How many events record a tool call. */
  readonly toolCalls: number;
}

/** What to filter a trace by. An absent field does not filter. */
export interface TraceFilter {
  /** An exact stage. */
  readonly stage?: TraceStage;
  /** An exact site-relative file. */
  readonly file?: string;
  /** A task id, or a case-insensitive part of the goal. */
  readonly task?: string;
  /** An exact event status. */
  readonly status?: TraceEventStatus;
}

/** One stage's share of a trace. */
export interface TraceStageCount {
  readonly stage: TraceStage;
  readonly events: number;
}

/** One status's share of a trace. */
export interface TraceStatusCount {
  readonly status: TraceEventStatus;
  readonly events: number;
}

/** A trace at a glance, with links to the evidence it points at. */
export interface TraceSummary {
  readonly id: string;
  readonly task: TraceTask;
  readonly snapshot: string;
  readonly events: number;
  readonly receipts: number;
  readonly stages: readonly TraceStageCount[];
  readonly statuses: readonly TraceStatusCount[];
  /** Every result reference and receipt reference, deduplicated in first-appearance order. */
  readonly evidence: readonly string[];
  /** Present when the trace was bounded. */
  readonly truncation?: TraceTruncation;
}

/** What kind of difference replay found. */
export type TraceDifferenceKind = "task" | "snapshot" | "order" | "event" | "hash" | "result" | "receipt";

/** One difference between a recorded trace and a replay. */
export interface TraceDifference {
  readonly kind: TraceDifferenceKind;
  /** JSON Pointer to the value in the recorded trace. */
  readonly path: string;
  /** What the recorded trace holds. */
  readonly expected: string;
  /** What the replay produced. */
  readonly actual: string;
}

/** What replaying one trace found. Timing values are never compared. */
export interface TraceReplayResult {
  /** True when the replay matches the recorded trace, or when a single trace is internally sound. */
  readonly ok: boolean;
  /** The snapshot the replay ran against; the recorded one, or the one the caller required. */
  readonly snapshot: string;
  /** Why the replay could not run; empty on success. */
  readonly problems: readonly TraceProblem[];
  /** Every difference, in event order, receipts last. */
  readonly differences: readonly TraceDifference[];
  /** The event count the replay walked. */
  readonly events: number;
}

/** What another agent needs to continue from a trace, without its conversation. */
export interface TraceHandoff {
  readonly task: TraceTask;
  readonly snapshot: string;
  /** The status of the last event: where the work stopped. */
  readonly state: TraceEventStatus | null;
  /** The results and receipts that name a change. */
  readonly changes: readonly TraceReceipt[];
  /** The decisions that shaped the run, with their reasons and policies. */
  readonly decisions: readonly {
    readonly sequence: number;
    readonly kind: TraceEventKind;
    readonly reason: string;
    readonly policy: string;
  }[];
  /** Work that did not finish: failed, refused, or skipped events, in order. */
  readonly remaining: readonly {
    readonly sequence: number;
    readonly capability: string;
    readonly status: TraceEventStatus;
    readonly reason?: string;
  }[];
  /** Every receipt, so the next agent can open the evidence. */
  readonly receipts: readonly TraceReceipt[];
  /** Present when the trace was bounded; the handoff inherits the warning. */
  readonly truncation?: TraceTruncation;
}

/** A bounded trace, plus what was removed. */
export interface TraceBound {
  readonly trace: TraceDocument;
  /** Present exactly when at least one event was dropped. */
  readonly truncation?: TraceTruncation;
}

/** The public projection of a trace: only fields an export may carry. */
export interface TraceExport {
  /** The file name; derived from the trace id, never from a local path. */
  readonly filename: string;
  /** The exported document. */
  readonly document: TraceDocument;
}
