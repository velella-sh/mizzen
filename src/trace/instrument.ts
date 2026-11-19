/**
 * Record key entry points: an applied edit, a verification, a context pack, and the MCP edit tool.
 *
 * Each adapter turns an existing result into one trace event with its safe input hash, status,
 * result reference, and links. The adapters are pure until a caller writes the trace; `MIZZEN_TRACE`
 * is the only switch that writes, and with it unset every helper returns without touching a file.
 *
 * A call outside a registered task has no task contract, so its trace is pinned to the capability
 * and the content hash instead of a task snapshot. That keeps the trace honest: the same call gives
 * the same ids, and no local path is ever written.
 *
 * shortcut: a standalone call records a synthesized task/snapshot, not a registered TaskDocument;
 * upgrade when callers pass a task into these entry points.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { TaskSnapshot } from "../contracts/task.ts";
import type { TraceDocument, TraceEvent, TraceTask } from "../contracts/trace.ts";
import { version } from "../index.ts";
import { taskSnapshot } from "../tasks/snapshot.ts";
import { TraceRecorder } from "./record.ts";
import { inputHashOf } from "./safe.ts";

/** A task and snapshot for a call that was not registered as a task. */
export interface StandaloneTrace {
  readonly task: TraceTask;
  readonly snapshot: TaskSnapshot;
}

/** What an instrumentation call may add besides the result. */
export interface RecordOptions {
  readonly subtask?: string;
  readonly pack?: string;
  readonly transaction?: string;
  readonly durationMs?: number;
  /** The site root, so an absolute proof or pack path becomes a site-relative reference. */
  readonly root?: string;
}

/** The edit apply fields a trace needs. */
export interface AppliedEdit {
  readonly file: string;
  readonly beforeHash: string;
  readonly afterHash: string;
  readonly proof?: string;
  readonly dryRun: boolean;
  readonly span: { readonly line: number; readonly column: number; readonly endLine: number; readonly endColumn: number };
  readonly patchHash: string;
  readonly diffHash: string;
}

/** The verification fields a trace needs. */
export interface VerifiedProof {
  readonly ok: boolean;
  readonly proof: string;
  readonly siteRoot: string;
  readonly files: number;
  readonly doctor: string;
  readonly failures: readonly { readonly kind: string }[];
}

/** The pack fields a trace needs. */
export interface CompiledContext {
  readonly markdown: string;
  readonly evidence: { readonly accounting: { readonly used: number }; readonly build: { readonly id: string } };
}

/** The MCP edit result fields a trace needs. */
export interface McpEditResult {
  readonly file: string;
  readonly beforeHash: string;
  readonly afterHash: string;
  readonly proof?: string;
  readonly diagnostics?: number;
}

/** A deterministic task and snapshot for an unregistered call. */
export function standaloneTrace(capability: string, contentHash?: string): StandaloneTrace {
  return {
    task: { id: inputHashOf({ standalone: capability }), goal: `Run ${capability}` },
    snapshot: taskSnapshot({
      content: contentHash ?? inputHashOf({ standalone: capability }),
      data: inputHashOf({ standalone: "data" }),
      config: inputHashOf({ standalone: "config" }),
      tooling: inputHashOf({ version }),
    }),
  };
}

/** A reference relative to the site root, or `undefined` when the path lies outside it. */
export function siteReference(root: string, path: string): string | undefined {
  const absolute = resolve(path);
  const base = resolve(root);
  if (!isAbsolute(absolute)) return undefined;
  const shown = relative(base, absolute).replace(/\\/g, "/");
  return shown === "" || shown.startsWith("..") || isAbsolute(shown) ? undefined : shown;
}

/** Records one applied (or dry-run) edit, linking its patch, span, transaction, and diff. */
export function recordEditApply(recorder: TraceRecorder, result: AppliedEdit, options: RecordOptions = {}): TraceEvent {
  const transaction = options.transaction ?? inputHashOf({ before: result.beforeHash, after: result.afterHash });
  const proof = result.proof === undefined ? null : referenceOf(result.proof, options.root);
  if (proof !== null) recorder.receipt("proof", proof);
  return recorder.append({
    stage: "edit",
    kind: "edit",
    capability: "edit.apply",
    status: result.dryRun ? "skipped" : "ok",
    input: { file: result.file, beforeHash: result.beforeHash },
    result: proof,
    file: result.file,
    ...(options.subtask === undefined ? {} : { subtask: options.subtask }),
    ...(options.durationMs === undefined ? {} : { durationMs: options.durationMs }),
    links: {
      ...(options.pack === undefined ? {} : { pack: options.pack }),
      patch: result.patchHash,
      span: result.span,
      transaction,
      diff: result.diffHash,
    },
  });
}

/** Records one proof verification. */
export function recordVerification(recorder: TraceRecorder, result: VerifiedProof, options: RecordOptions = {}): TraceEvent {
  const proof = siteReference(result.siteRoot, result.proof);
  if (proof !== undefined) recorder.receipt("verification", proof);
  return recorder.append({
    stage: "verify",
    kind: "verify",
    capability: "edit.verify",
    status: result.ok ? "ok" : "failed",
    input: { proof: proof ?? inputHashOf({ proof: result.proof }), files: result.files, doctor: result.doctor },
    result: proof ?? null,
    ...(options.subtask === undefined ? {} : { subtask: options.subtask }),
    ...(options.durationMs === undefined ? {} : { durationMs: options.durationMs }),
    ...(result.ok
      ? {}
      : {
          reason: `Verification failed: ${result.failures[0]?.kind ?? "unknown"}.`,
        }),
  });
}

/** Records one compiled context pack, including the tokens it used. */
export function recordPack(recorder: TraceRecorder, packed: CompiledContext, options: RecordOptions & { readonly out?: string } = {}): TraceEvent {
  const pack = inputHashOf(packed.markdown);
  const reference = options.out === undefined ? pack : referenceOf(options.out, options.root);
  recorder.receipt("pack", reference);
  return recorder.append({
    stage: "context",
    kind: "context",
    capability: "pack",
    status: "ok",
    input: { build: packed.evidence.build.id, tokens: packed.evidence.accounting.used },
    result: reference,
    ...(options.subtask === undefined ? {} : { subtask: options.subtask }),
    ...(options.durationMs === undefined ? {} : { durationMs: options.durationMs }),
    links: { pack },
    cost: { contextTokens: packed.evidence.accounting.used, refillTokens: 0, toolCalls: 1 },
  });
}

/** Records one MCP `apply_edit` call. */
export function recordMcpEdit(
  recorder: TraceRecorder,
  input: { readonly file: string; readonly span: AppliedEdit["span"] },
  result: McpEditResult,
  options: RecordOptions = {},
): TraceEvent {
  const proof = result.proof === undefined ? null : referenceOf(result.proof, options.root);
  if (proof !== null) recorder.receipt("proof", proof);
  return recorder.append({
    stage: "edit",
    kind: "tool",
    capability: "mcp.apply_edit",
    status: "ok",
    input: { file: input.file, beforeHash: result.beforeHash },
    result: proof,
    file: result.file,
    ...(options.subtask === undefined ? {} : { subtask: options.subtask }),
    ...(options.durationMs === undefined ? {} : { durationMs: options.durationMs }),
    links: {
      ...(options.pack === undefined ? {} : { pack: options.pack }),
      span: input.span,
      transaction: inputHashOf({ before: result.beforeHash, after: result.afterHash }),
    },
  });
}

/** A reference to a result: site-relative when a root is known and the path is inside it, else its hash. */
function referenceOf(path: string, root: string | undefined): string {
  if (root !== undefined) {
    const shown = siteReference(root, path);
    if (shown !== undefined) return shown;
  }
  const normalized = path.replace(/\\/g, "/");
  if (!isAbsolute(path) && !normalized.startsWith("..") && !normalized.startsWith("/")) return normalized;
  return `result-${inputHashOf(path)}`;
}

/** Writes a trace when `MIZZEN_TRACE` names a file; otherwise does nothing. */
export async function writeTraceFromEnv(trace: TraceDocument, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const path = env.MIZZEN_TRACE?.trim();
  if (path === undefined || path === "") return undefined;
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(resolve(path), `${JSON.stringify(trace, null, 2)}\n`, "utf8");
  return path;
}

/** Records one CLI edit apply, best effort: a trace failure never fails an applied edit. */
export async function traceEditApply(
  result: AppliedEdit,
  root: string | undefined = undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!enabled(env)) return;
  try {
    const recorder = new TraceRecorder(standaloneTrace("edit.apply", result.beforeHash));
    recordEditApply(recorder, result, root === undefined ? {} : { root });
    await writeTraceFromEnv(recorder.document(), env);
  } catch {
    // A trace is evidence about the call, not a precondition for it.
  }
}

/** Records one CLI verification, best effort. */
export async function traceVerification(result: VerifiedProof, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!enabled(env)) return;
  try {
    const recorder = new TraceRecorder(standaloneTrace("edit.verify", inputHashOf({ proof: result.proof })));
    recordVerification(recorder, result);
    await writeTraceFromEnv(recorder.document(), env);
  } catch {
    // See traceEditApply.
  }
}

/** Records one CLI pack, best effort. */
export async function tracePack(
  packed: CompiledContext,
  options: { readonly out?: string; readonly root?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!enabled(env)) return;
  try {
    const recorder = new TraceRecorder(standaloneTrace("pack", inputHashOf(packed.markdown)));
    recordPack(recorder, packed, options);
    await writeTraceFromEnv(recorder.document(), env);
  } catch {
    // See traceEditApply.
  }
}

/** Records one MCP apply_edit, best effort. */
export async function traceMcpEdit(
  input: { readonly file: string; readonly span: AppliedEdit["span"] },
  result: McpEditResult,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!enabled(env)) return;
  try {
    const recorder = new TraceRecorder(standaloneTrace("mcp.apply_edit", result.beforeHash));
    recordMcpEdit(recorder, input, result);
    await writeTraceFromEnv(recorder.document(), env);
  } catch {
    // See traceEditApply.
  }
}

/** True when a trace destination is configured. */
function enabled(env: NodeJS.ProcessEnv): boolean {
  const path = env.MIZZEN_TRACE?.trim();
  return path !== undefined && path !== "";
}
