/**
 * Parse an untrusted trace into {@link TraceDocument}, or explain every way it is malformed.
 *
 * The shape is checked against `../../schema/trace.schema.json` with ajv, then the cross-field rules
 * run: sequences are contiguous, only the first event has no parent, every parent names an earlier
 * event, receipts and references are safe, decisions, refusals, and approvals carry a reason and a
 * policy, the snapshot id matches its four hashes, and the trace id matches its content. The parser
 * derives the ids, the nondeterministic pointers, and the receipt ids, so a parsed trace has exactly
 * one stable form: the same events give the same bytes.
 *
 * Parsing reads no file, clock, network, or model. Private model reasoning has no field here; an
 * object that carries one is refused as an unknown key.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { ErrorObject } from "ajv";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import type { TaskSnapshot } from "../contracts/task.ts";
import type {
  TraceDocument,
  TraceEvent,
  TraceEventKind,
  TraceLinks,
  TraceParseResult,
  TraceProblem,
  TraceReceipt,
  TraceSpan,
  TraceStage,
  TraceTruncation,
} from "../contracts/trace.ts";
import { canonicalJson } from "../data/lock.ts";
import { snapshotIdOf } from "../tasks/snapshot.ts";
import {
  hasPrivateReasoning,
  receiptIdOf,
  redactText,
  referenceProblem,
} from "./safe.ts";

/** The only trace version this parser accepts. */
export const TRACE_VERSION = 1;

/** The event kinds whose reason and policy the trace must keep. */
export const DECISION_KINDS: readonly TraceEventKind[] = ["decision", "refusal", "approval"];

// ajv is CommonJS: its default export is the class at run time, but its types name it.
const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;
const schema = JSON.parse(
  readFileSync(new URL("../../schema/trace.schema.json", import.meta.url), "utf8"),
) as object;
const validateShape = new Ajv2020({ strict: true, allErrors: true, verbose: true }).compile(schema);

interface RawEvent {
  readonly sequence: number;
  readonly parent: number | null;
  readonly stage: TraceStage;
  readonly kind: TraceEventKind;
  readonly capability: string;
  readonly status: TraceEvent["status"];
  readonly inputHash: string;
  readonly result: string | null;
  readonly file?: string;
  readonly subtask?: string;
  readonly links?: TraceLinks;
  readonly reason?: string;
  readonly policy?: string;
  readonly cost?: TraceEvent["cost"];
  readonly at?: string;
  readonly durationMs?: number;
}

interface RawTrace {
  readonly version: 1;
  readonly id?: string;
  readonly task: { readonly id: string; readonly goal: string };
  readonly snapshot: TaskSnapshot;
  readonly events: readonly RawEvent[];
  readonly receipts: readonly { readonly id?: string; readonly kind: TraceReceipt["kind"]; readonly reference: string }[];
  readonly nondeterministic?: readonly string[];
  readonly truncation?: TraceTruncation;
}

/** The trace id: the normalized document without its derived timing list. */
export function traceIdOf(trace: {
  readonly version: 1;
  readonly task: TraceDocument["task"];
  readonly snapshot: TaskSnapshot;
  readonly events: readonly TraceEvent[];
  readonly receipts: readonly TraceReceipt[];
  readonly truncation?: TraceTruncation;
}): string {
  return canonicalHash("mizzen-trace", {
    version: trace.version,
    task: trace.task,
    snapshot: trace.snapshot,
    events: trace.events,
    receipts: trace.receipts,
    ...(trace.truncation === undefined ? {} : { truncation: trace.truncation }),
  });
}

/** SHA-256 of a domain and a canonical value, so two ids with different meanings never collide. */
function canonicalHash(domain: string, value: unknown): string {
  return createHashHex(`${domain}\0${canonicalJson(value)}`);
}

/** SHA-256 of one string, kept here so the module owns no other hash shape. */
function createHashHex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Parses a trace from an already-decoded JSON value such as `JSON.parse(text)`. */
export function parseTrace(value: unknown): TraceParseResult {
  if (!validateShape(value)) return { problems: problemsFromAjv(validateShape.errors ?? []) };
  if (hasPrivateReasoning(value)) {
    return {
      problems: [{
        path: "",
        code: "trace.private-reasoning",
        message: "A trace keeps decisions and their reasons, never private model reasoning or chain of thought.",
      }],
    };
  }
  return normalize(value as RawTrace);
}

/** Fills the derived ids and pointers, and checks the rules a single field cannot express. */
function normalize(raw: RawTrace): TraceParseResult {
  const problems: TraceProblem[] = [];
  const events: TraceEvent[] = [];

  raw.events.forEach((event, index) => {
    if (event.sequence !== index) {
      problems.push({
        path: `/events/${index}/sequence`,
        code: "trace.sequence",
        message: `Event ${index} has sequence ${event.sequence}; events must be ordered from 0 without gaps.`,
      });
    }
    if (index === 0 && event.parent !== null) {
      problems.push({
        path: "/events/0/parent",
        code: "trace.parent",
        message: "The first event is the root and must have `parent: null`.",
      });
    }
    if (index > 0 && event.parent === null) {
      problems.push({
        path: `/events/${index}/parent`,
        code: "trace.parent",
        message: `Event ${index} needs a parent: the sequence of an earlier event.`,
      });
    }
    if (event.parent !== null && (event.parent < 0 || event.parent >= index)) {
      problems.push({
        path: `/events/${index}/parent`,
        code: "trace.parent",
        message: `Event ${index} names parent ${event.parent}; a parent must be an earlier event.`,
      });
    }

    const resultProblem = event.result === null ? undefined : referenceProblem(event.result);
    if (resultProblem !== undefined) {
      problems.push({ path: `/events/${index}/result`, code: "trace.reference", message: `The result ${resultProblem}.` });
    }
    if (event.file !== undefined) {
      const fileProblem = referenceProblem(event.file);
      if (fileProblem !== undefined) {
        problems.push({ path: `/events/${index}/file`, code: "trace.path", message: `The file ${fileProblem}.` });
      }
    }
    problems.push(...linkProblems(event.links, `/events/${index}/links`));

    const decision = DECISION_KINDS.includes(event.kind);
    if (decision && (event.reason === undefined || event.reason.trim() === "")) {
      problems.push({
        path: `/events/${index}/reason`,
        code: "trace.reason",
        message: `A \`${event.kind}\` event needs a reason; state why, not what the model thought.`,
      });
    }
    if (decision && (event.policy === undefined || event.policy.trim() === "")) {
      problems.push({
        path: `/events/${index}/policy`,
        code: "trace.policy",
        message: `A \`${event.kind}\` event needs a policy reference, such as \`policy.edit-requires-proof\`.`,
      });
    }

    events.push({
      sequence: index,
      parent: event.parent,
      stage: event.stage,
      kind: event.kind,
      capability: redactText(event.capability.trim()),
      status: event.status,
      inputHash: event.inputHash,
      result: event.result,
      ...(event.file === undefined ? {} : { file: event.file }),
      ...(event.subtask === undefined ? {} : { subtask: redactText(event.subtask.trim()) }),
      ...(event.links === undefined ? {} : { links: linkOf(event.links) }),
      ...(event.reason === undefined ? {} : { reason: redactText(event.reason.trim()) }),
      ...(event.policy === undefined ? {} : { policy: redactText(event.policy.trim()) }),
      ...(event.cost === undefined ? {} : { cost: { ...event.cost } }),
      ...(event.at === undefined ? {} : { at: event.at }),
      ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
    });
  });

  const receipts: TraceReceipt[] = [];
  const receiptIds = new Set<string>();
  raw.receipts.forEach((receipt, index) => {
    const problem = referenceProblem(receipt.reference);
    if (problem !== undefined) {
      problems.push({ path: `/receipts/${index}/reference`, code: "trace.reference", message: `The receipt ${problem}.` });
    }
    const id = receiptIdOf(receipt.kind, receipt.reference);
    if (receipt.id !== undefined && receipt.id !== id) {
      problems.push({
        path: `/receipts/${index}/id`,
        code: "trace.receipt-id",
        message: `The receipt id does not match its kind and reference; expected \`${id}\`.`,
      });
    }
    if (receiptIds.has(id)) {
      problems.push({
        path: `/receipts/${index}`,
        code: "trace.receipt-duplicate",
        message: "Two receipts name the same kind and reference.",
      });
    }
    receiptIds.add(id);
    receipts.push({ id, kind: receipt.kind, reference: receipt.reference });
  });

  const snapshotId = snapshotIdOf(raw.snapshot);
  if (raw.snapshot.id !== snapshotId) {
    problems.push({
      path: "/snapshot/id",
      code: "trace.snapshot",
      message: `The snapshot id does not match its four hashes; expected \`${snapshotId}\`.`,
    });
  }

  const nondeterministic = nondeterministicOf(events);
  if (
    raw.nondeterministic !== undefined &&
    (raw.nondeterministic.length !== nondeterministic.length ||
      raw.nondeterministic.some((pointer, index) => pointer !== nondeterministic[index]))
  ) {
    problems.push({
      path: "/nondeterministic",
      code: "trace.nondeterministic",
      message: `The nondeterministic list must be exactly the timing pointers derived from the events: ${nondeterministic.length === 0 ? "none" : nondeterministic.map((pointer) => `\`${pointer}\``).join(", ")}.`,
    });
  }

  const truncation = raw.truncation === undefined ? undefined : truncationOf(raw.truncation);
  const task = { id: raw.task.id, goal: redactText(raw.task.goal.trim()) };
  const id = traceIdOf({ version: TRACE_VERSION, task, snapshot: raw.snapshot, events, receipts, ...(truncation === undefined ? {} : { truncation }) });
  if (raw.id !== undefined && raw.id !== id) {
    problems.push({
      path: "/id",
      code: "trace.id",
      message: `The trace id does not match its content; expected \`${id}\`.`,
    });
  }

  if (problems.length > 0) return { problems };
  return {
    trace: {
      version: TRACE_VERSION,
      id,
      task,
      snapshot: raw.snapshot,
      events,
      receipts,
      nondeterministic,
      ...(truncation === undefined ? {} : { truncation }),
    },
    problems,
  };
}

/** The links with their references checked, and the same fields in a fixed order. */
function linkOf(links: TraceLinks): TraceLinks {
  return {
    ...(links.pack === undefined ? {} : { pack: links.pack }),
    ...(links.patch === undefined ? {} : { patch: links.patch }),
    ...(links.span === undefined ? {} : { span: spanOf(links.span) }),
    ...(links.transaction === undefined ? {} : { transaction: links.transaction }),
    ...(links.diff === undefined ? {} : { diff: links.diff }),
  };
}

/** A span in a fixed field order. */
function spanOf(span: TraceSpan): TraceSpan {
  return { line: span.line, column: span.column, endLine: span.endLine, endColumn: span.endColumn };
}

/** Every unsafe link reference, at its own path. */
function linkProblems(links: TraceLinks | undefined, path: string): readonly TraceProblem[] {
  if (links === undefined) return [];
  const problems: TraceProblem[] = [];
  for (const key of ["pack", "patch", "transaction", "diff"] as const) {
    const value = links[key];
    if (value === undefined) continue;
    const problem = referenceProblem(value);
    if (problem !== undefined) {
      problems.push({ path: `${path}/${key}`, code: "trace.reference", message: `The link ${problem}.` });
    }
  }
  return problems;
}

/** The derived timing pointers, in event order. */
export function nondeterministicOf(events: readonly TraceEvent[]): readonly string[] {
  const pointers: string[] = [];
  events.forEach((event, index) => {
    if (event.at !== undefined) pointers.push(`/events/${index}/at`);
    if (event.durationMs !== undefined) pointers.push(`/events/${index}/durationMs`);
  });
  return pointers;
}

/** The truncation with its summary redacted and trimmed. */
function truncationOf(truncation: TraceTruncation): TraceTruncation {
  return {
    droppedEvents: truncation.droppedEvents,
    droppedBytes: truncation.droppedBytes,
    summary: redactText(truncation.summary.trim()),
  };
}

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Translates ajv findings into stable codes and sentences, collapsing oneOf branches. */
function problemsFromAjv(errors: readonly ErrorObject[]): readonly TraceProblem[] {
  const branchPaths = new Set(errors.filter((error) => error.keyword === "oneOf").map((error) => error.instancePath));
  return errors
    .filter(
      (error) =>
        error.keyword === "oneOf" ||
        ![...branchPaths].some((path) => error.instancePath === path || error.instancePath.startsWith(`${path}/`)),
    )
    .map((error) => problemFromAjv(error));
}

/** One ajv finding as a trace problem. */
function problemFromAjv(error: ErrorObject): TraceProblem {
  const path = error.instancePath;
  switch (error.keyword) {
    case "required": {
      const key = String(error.params.missingProperty ?? "");
      return { path, code: "trace.missing", message: `Missing required field \`${key}\` at \`${path || "/"}\`.` };
    }
    case "additionalProperties": {
      const key = String(error.params.additionalProperty ?? "");
      const allowed = Object.keys((error.parentSchema?.properties ?? {}) as Record<string, unknown>).sort(byCodePoint);
      return {
        path: `${path}/${key}`,
        code: "trace.unknown-key",
        message: `Unknown field \`${key}\`. Use one of: ${allowed.map((name) => `\`${name}\``).join(", ")}.`,
      };
    }
    case "oneOf":
      return { path, code: "trace.shape", message: `\`${path || "/"}\` must be a string reference or null.` };
    case "enum": {
      const allowed = ((error.params as { readonly allowedValues?: readonly unknown[] }).allowedValues ?? []).map(String);
      return {
        path,
        code: "trace.enum",
        message: `\`${path || "/"}\` must be one of: ${allowed.map((value) => `\`${value}\``).join(", ")}.`,
      };
    }
    case "type":
      return {
        path,
        code: "trace.type",
        message: `\`${path || "/"}\` must be ${String(error.params.type)}.`,
      };
    case "const":
      return { path, code: "trace.version", message: "Only trace version 1 exists; set `version` to 1." };
    default:
      return { path, code: "trace.shape", message: `\`${path || "/"}\` ${error.message ?? "is invalid"}.` };
  }
}
