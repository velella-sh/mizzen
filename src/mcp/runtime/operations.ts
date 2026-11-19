/**
 * The recoverable half of the MCP server: sessions that pin one snapshot, operations that outlive one request and
 * one stdio connection, bounded progress events, cancellation at safe boundaries, separate stage deadlines, and
 * idempotency receipts that survive a reconnect. Records live under `<site>/.mizzen/mcp/runtime/` and are rewritten
 * atomically; a read-only operation whose process died is resumed from the work it had really finished.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Diagnostic } from "../../contracts/index.ts";
import type { ContextRequest } from "../../contracts/context-request.ts";
import type { TaskEvent } from "../../contracts/task.ts";
import { verifyProof } from "../../cli/edit-verify.ts";
import { compilePack } from "../../packs/compile.ts";
import { parseContextRequest } from "../../packs/task.ts";
import { replayTask } from "../../tasks/lifecycle.ts";
import { MAX_PACK_TOKENS, McpError, type Limits } from "../limits.ts";
import type { SiteState } from "../site.ts";
import { failureOf, publicValue, type McpFailure } from "./errors.ts";

/** The long-running work a client may start without waiting for it. */
export type OperationKind = "pack" | "verify" | "replay";

/** Where an operation is in its life. `interrupted` is a non-resumable operation whose process died. */
export type OperationStatus = "running" | "succeeded" | "failed" | "cancelled" | "interrupted";

/** One real unit of work that finished, in order. */
export interface OperationEvent {
  readonly seq: number;
  readonly stage: string;
  readonly completed: number;
  readonly total: number;
  readonly expected: string;
}

/** What a client sees for one operation. */
export interface OperationView {
  readonly operationId: string;
  readonly kind: OperationKind;
  readonly status: OperationStatus;
  readonly stage: string;
  readonly work: { readonly completed: number; readonly total: number };
  readonly expected: string;
  readonly events: readonly OperationEvent[];
  readonly dropped: number;
  readonly snapshot: string;
  readonly resumed: boolean;
  readonly result?: Record<string, unknown>;
  readonly error?: McpFailure;
}

/** An apply receipt, kept so the same idempotency key returns the same answer. */
export interface Receipt {
  readonly id: string;
  readonly result: Record<string, unknown>;
}

interface StoredEvent extends OperationEvent {}

interface StoredOperation {
  id: string;
  kind: OperationKind;
  status: OperationStatus;
  stage: string;
  completed: number;
  total: number;
  expected: string;
  events: StoredEvent[];
  dropped: number;
  lastSeq: number;
  snapshot: string;
  plan?: Record<string, unknown>;
  progressToken?: string | number;
  owner: string;
  pid: number;
  resumed: boolean;
  result?: Record<string, unknown>;
  error?: McpFailure;
  /** Work already finished by a previous process, so a resumed operation returns one complete result. */
  partial?: unknown[];
}

interface SessionFile {
  version: 1;
  id: string;
  snapshot: string;
  nextOperation: number;
  operations: StoredOperation[];
}

interface ReceiptRecord {
  key: string;
  payloadHash: string;
  session: string;
  id: string;
  result: Record<string, unknown>;
}

interface ReceiptFile {
  version: 1;
  receipts: ReceiptRecord[];
}

interface InternalSession {
  file: SessionFile;
  resumed: boolean;
}

/** Runtimes alive in this process, so an operation owned by one of them is not resumed twice. */
const LIVE = new Set<string>();
const READ_ONLY = new Set<OperationKind>(["pack", "verify", "replay"]);

/** The snapshot id a site change is measured against. */
function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function idOf(token: string): string {
  return `ses-${sha(`mizzen-mcp-session\0${token}`).slice(0, 16)}`;
}

function receiptIdOf(key: string): string {
  return `rcpt-${sha(`mizzen-mcp-receipt\0${key}`).slice(0, 12)}`;
}

/** True when the process that wrote an operation is still running a runtime. */
function ownerAlive(owner: string): boolean {
  if (LIVE.has(owner)) return true;
  const pid = Number(owner.split(":")[0]);
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One session of one server: its pinned snapshot and its own operations and receipts. */
export class Session {
  readonly id: string;
  readonly token: string;
  readonly #runtime: Runtime;
  readonly #internal: InternalSession;

  constructor(runtime: Runtime, internal: InternalSession, token: string, protocolVersion: string) {
    this.#runtime = runtime;
    this.#internal = internal;
    this.id = internal.file.id;
    this.token = token;
    this.protocolVersion = protocolVersion;
  }

  /** The MCP protocol version this session negotiated. */
  protocolVersion: string;

  /** Whether the negotiated version knows `structuredContent`; older clients get text only. */
  modern = true;

  get snapshot(): string {
    return this.#internal.file.snapshot;
  }

  /** Moves the session onto a snapshot the client has declared. */
  async pin(snapshot: string): Promise<void> {
    this.#internal.file.snapshot = snapshot;
    await this.#runtime.save(this.#internal);
  }

  /** Takes the snapshot this session's own successful edit produced. */
  adopt(snapshot: string): void {
    this.#internal.file.snapshot = snapshot;
    void this.#runtime.save(this.#internal);
  }
}

/** The recoverable state one server answers from; every method waits for the first disk read. */
export class Runtime {
  readonly #site: SiteState;
  readonly #limits: Limits;
  readonly #folders: () => readonly string[];
  readonly #dir: string;
  readonly #owner = `${process.pid}:${randomUUID()}`;
  readonly #sessions = new Map<string, InternalSession>();
  readonly #running = new Map<string, { controller: AbortController; timer: NodeJS.Timeout | undefined }>();
  #receipts: ReceiptRecord[] | undefined;
  #saving: Promise<void> = Promise.resolve();
  #writeSeq = 0;
  #closing = false;
  #ready: Promise<void> | undefined;

  constructor(site: SiteState, limits: Limits, folders: () => readonly string[]) {
    this.#site = site;
    this.#limits = limits;
    this.#folders = folders;
    this.#dir = join(site.root, ".mizzen", "mcp", "runtime");
    LIVE.add(this.#owner);
  }

  /** Sends progress notifications when the transport can carry them. */
  notify: ((message: Record<string, unknown>) => void) | undefined;

  async openSession(token: string, snapshot: string, protocolVersion: string, pin: boolean): Promise<Session> {
    await this.#load();
    const id = idOf(token);
    let internal = this.#sessions.get(id);
    if (internal === undefined) {
      const file = await this.#readSession(id, snapshot);
      internal = { file, resumed: false };
      this.#sessions.set(id, internal);
      this.#resume(internal);
    }
    if (pin && internal.file.snapshot !== snapshot) {
      internal.file.snapshot = snapshot;
      await this.save(internal);
    }
    return new Session(this, internal, token, protocolVersion);
  }

  // -- operations -------------------------------------------------------------------------------------------------

  async start(session: Session, kind: OperationKind, input: Record<string, unknown>, progressToken?: string | number): Promise<OperationView> {
    await this.#load();
    const internal = this.#sessions.get(session.id);
    if (internal === undefined) throw new McpError("unknown-session", "This session is not open.", { retryable: false, stage: "operation" });
    const running = internal.file.operations.filter((op) => op.status === "running").length;
    if (running >= this.#limits.maxOperations) {
      throw new McpError(
        "busy",
        `This session already runs ${running} operations (limit ${this.#limits.maxOperations}); retry when one finishes.`,
        { retryable: true, stage: "operation", data: { limit: this.#limits.maxOperations } },
      );
    }
    const plan = await this.#prepare(kind, input);
    const id = `op-${String(internal.file.nextOperation++).padStart(4, "0")}`;
    const op: StoredOperation = {
      id,
      kind,
      status: "running",
      stage: "start",
      completed: 0,
      total: plan.total,
      expected: plan.expected,
      events: [],
      dropped: 0,
      lastSeq: 0,
      snapshot: internal.file.snapshot,
      plan: plan.plan,
      ...(progressToken === undefined ? {} : { progressToken }),
      owner: this.#owner,
      pid: process.pid,
      resumed: false,
    };
    this.#event(op, "start", 0, plan.total, plan.expected);
    this.#prune(internal);
    internal.file.operations.push(op);
    await this.save(internal);
    this.#schedule(internal, op, 0);
    return this.#view(op);
  }

  async operation(session: Session, id: string, after: number | undefined, waitMs: number): Promise<OperationView> {
    await this.#load();
    const internal = this.#sessions.get(session.id);
    const op = internal?.file.operations.find((candidate) => candidate.id === id);
    if (internal === undefined || op === undefined) {
      throw new McpError("unknown-operation", `No operation ${id} exists in this session.`, { retryable: false, stage: "operation" });
    }
    const deadline = Date.now() + Math.max(0, Math.min(waitMs, 5_000));
    while (op.status === "running" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    const view = this.#view(op);
    if (after === undefined) return view;
    const first = op.events[0]?.seq ?? op.lastSeq + 1;
    if (after < first - 1) {
      throw new McpError(
        "event-gap",
        `Progress events up to ${op.lastSeq} exist, but events before ${first} were dropped to bound the queue. Retry from ${op.lastSeq}.`,
        { retryable: true, stage: "operation", task: id, data: { firstSeq: first, lastSeq: op.lastSeq, dropped: op.dropped, retryFrom: op.lastSeq } },
      );
    }
    return { ...view, events: view.events.filter((event) => event.seq > after) };
  }

  async cancel(session: Session, id: string): Promise<OperationView> {
    await this.#load();
    const internal = this.#sessions.get(session.id);
    const op = internal?.file.operations.find((candidate) => candidate.id === id);
    if (internal === undefined || op === undefined) {
      throw new McpError("unknown-operation", `No operation ${id} exists in this session.`, { retryable: false, stage: "operation" });
    }
    if (op.status !== "running" && op.status !== "interrupted") return this.#view(op);
    op.status = "cancelled";
    delete op.result;
    op.error = failureOf("cancelled", "The operation was cancelled at a safe boundary; no partial result is kept.", {
      stage: "operation",
      retryable: true,
      task: id,
      folders: this.#folders(),
    });
    op.stage = "cancelled";
    this.#event(op, "cancelled", op.completed, op.total, "no partial result");
    this.#running.get(id)?.controller.abort();
    await this.save(internal);
    return this.#view(op);
  }

  // -- receipts ---------------------------------------------------------------------------------------------------

  /** The receipt a key already produced, or a refusal when the key names different work or another session. */
  async receipt(session: Session, key: string, payloadHash: string): Promise<Receipt | undefined> {
    await this.#load();
    const found = this.#receipts?.find((record) => record.key === key);
    if (found === undefined) return undefined;
    if (found.payloadHash !== payloadHash) {
      throw new McpError("idempotency-conflict", "This idempotency key was used for a different payload; nothing was written. Use a new key for the changed edit.", {
        retryable: false,
        stage: "edit",
        data: { key },
      });
    }
    if (found.session !== session.id) {
      throw new McpError("idempotency-conflict", "This idempotency key belongs to another session; nothing was written.", {
        retryable: false,
        stage: "edit",
        data: { key },
      });
    }
    return { id: found.id, result: found.result };
  }

  async recordReceipt(session: Session, key: string, payloadHash: string, result: Record<string, unknown>): Promise<Receipt> {
    await this.#load();
    const id = receiptIdOf(key);
    const record: ReceiptRecord = {
      key,
      payloadHash,
      session: session.id,
      id,
      result: publicValue(result, this.#folders()) as Record<string, unknown>,
    };
    this.#receipts = [...(this.#receipts ?? []).filter((existing) => existing.key !== key), record];
    await this.#saveReceipts();
    return { id, result: record.result };
  }

  // -- lifecycle --------------------------------------------------------------------------------------------------

  /** Stops background work without turning it into a failure: a reconnect resumes read-only work. */
  async close(): Promise<void> {
    this.#closing = true;
    for (const running of this.#running.values()) {
      running.controller.abort();
      if (running.timer !== undefined) clearTimeout(running.timer);
    }
    await this.#saving.catch(() => undefined);
    LIVE.delete(this.#owner);
  }

  /** Writes one session file; calls are serialized so two operations cannot interleave their bytes. */
  async save(internal: InternalSession): Promise<void> {
    const body = JSON.stringify(internal.file);
    const seq = this.#writeSeq++;
    this.#saving = this.#saving
      .then(async () => {
        await mkdir(this.#dir, { recursive: true });
        const target = join(this.#dir, "sessions", `${internal.file.id}.json`);
        const temporary = `${target}.${process.pid}.${seq}.tmp`;
        await mkdir(join(this.#dir, "sessions"), { recursive: true });
        await writeFile(temporary, `${body}\n`, "utf8");
        await rename(temporary, target);
      })
      .catch(() => undefined);
    await this.#saving;
  }

  // -- internals --------------------------------------------------------------------------------------------------

  async #load(): Promise<void> {
    this.#ready ??= (async () => {
      await mkdir(this.#dir, { recursive: true });
      const text = await readFile(join(this.#dir, "receipts.json"), "utf8").catch(() => undefined);
      if (text === undefined) return;
      try {
        const parsed = JSON.parse(text) as Partial<ReceiptFile>;
        if (parsed.version === 1 && Array.isArray(parsed.receipts)) this.#receipts = parsed.receipts.filter(isReceipt);
      } catch {
        this.#receipts = [];
      }
    })();
    await this.#ready;
  }

  async #readSession(id: string, snapshot: string): Promise<SessionFile> {
    const text = await readFile(join(this.#dir, "sessions", `${id}.json`), "utf8").catch(() => undefined);
    if (text === undefined) return { version: 1, id, snapshot, nextOperation: 1, operations: [] };
    try {
      const parsed = JSON.parse(text) as Partial<SessionFile>;
      if (parsed.version !== 1 || parsed.id !== id || !Array.isArray(parsed.operations)) {
        return { version: 1, id, snapshot, nextOperation: 1, operations: [] };
      }
      return {
        version: 1,
        id,
        snapshot: typeof parsed.snapshot === "string" ? parsed.snapshot : snapshot,
        nextOperation: typeof parsed.nextOperation === "number" ? parsed.nextOperation : 1,
        operations: parsed.operations.filter(isOperation),
      };
    } catch {
      return { version: 1, id, snapshot, nextOperation: 1, operations: [] };
    }
  }

  #resume(internal: InternalSession): void {
    if (internal.resumed) return;
    internal.resumed = true;
    for (const op of internal.file.operations) {
      if (op.status !== "running") continue;
      if (ownerAlive(op.owner)) continue;
      if (!READ_ONLY.has(op.kind) || op.plan === undefined) {
        op.status = "interrupted";
        op.error = failureOf("interrupted", "The process that ran this operation ended before it finished; start it again.", {
          stage: "operation",
          retryable: true,
          task: op.id,
          folders: this.#folders(),
        });
        void this.save(internal);
        continue;
      }
      op.resumed = true;
      op.owner = this.#owner;
      op.pid = process.pid;
      // The events and `completed` count were written by the previous process; only the work after them runs again.
      this.#schedule(internal, op, op.completed);
    }
  }

  #schedule(internal: InternalSession, op: StoredOperation, resumeFrom: number): void {
    void this.#run(internal, op, resumeFrom);
  }

  async #run(internal: InternalSession, op: StoredOperation, resumeFrom: number): Promise<void> {
    const controller = new AbortController();
    let timedOut = false;
    const timeoutMs = op.kind === "pack" ? this.#limits.contextTimeoutMs : this.#limits.verifyTimeoutMs;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    timer.unref();
    this.#running.set(op.id, { controller, timer });
    const signal = controller.signal;
    const progress = async (stage: string, completed: number, total: number, expected: string): Promise<void> => {
      if (signal.aborted) return;
      op.stage = stage;
      op.completed = completed;
      op.total = total;
      op.expected = expected;
      const event = this.#event(op, stage, completed, total, expected);
      await this.save(internal);
      this.#emit(op, event);
    };
    try {
      const result = await this.#execute(op, planOf(op), signal, progress, resumeFrom);
      if (this.#terminal(op) || this.#closing) return;
      if (signal.aborted) throw new McpError("cancelled", "The operation was cancelled.");
      op.status = "succeeded";
      op.result = publicValue(result, this.#folders()) as Record<string, unknown>;
      delete op.plan;
      op.stage = "done";
      op.completed = op.total;
      this.#event(op, "done", op.completed, op.total, "the result is ready");
      await this.save(internal);
      this.#emit(op, op.events.at(-1)!);
    } catch (error) {
      if (this.#terminal(op) || this.#closing) return;
      if (signal.aborted && !timedOut) return; // cancel() already recorded it
      const failure =
        timedOut
          ? failureOf("operation-timeout", `${op.kind} took longer than ${timeoutMs} ms and was stopped.`, {
              stage: op.kind === "pack" ? "context" : "verify",
              retryable: true,
              task: op.id,
              folders: this.#folders(),
            })
          : error instanceof McpError
            ? failureOf(error.code, error.message, {
                stage: error.details.stage ?? "operation",
                ...(error.details.retryable === undefined ? {} : { retryable: error.details.retryable }),
                task: op.id,
                folders: this.#folders(),
                ...(error.details.data === undefined ? {} : { extra: error.details.data }),
              })
            : failureOf("operation-failed", reasonOf(error), { stage: "operation", retryable: true, task: op.id, folders: this.#folders() });
      op.status = "failed";
      op.error = failure;
      op.stage = "failed";
      this.#event(op, "failed", op.completed, op.total, "the operation stopped");
      await this.save(internal);
      this.#emit(op, op.events.at(-1)!);
    } finally {
      clearTimeout(timer);
      this.#running.delete(op.id);
    }
  }

  async #execute(
    op: StoredOperation,
    plan: Plan,
    signal: AbortSignal,
    progress: (stage: string, completed: number, total: number, expected: string) => Promise<void>,
    resumeFrom: number,
  ): Promise<Record<string, unknown>> {
    stopIfAborted(signal);
    if (plan.kind === "pack") {
      const diagnostics: Diagnostic[] = [];
      await progress("compile", 0, plan.total, "a pack under the token budget");
      const compiled = await compilePack(
        this.#site.site,
        plan.request,
        { renderPage: () => Promise.reject(new Error("pack builds no pages")), report: (d) => void diagnostics.push(d) },
        { warnings: this.#site.diagnostics },
      );
      stopIfAborted(signal);
      if (compiled === undefined) {
        throw new McpError("empty-pack", "The request selected no context.", { retryable: false, stage: "context" });
      }
      await progress("compile", plan.total, plan.total, "a pack under the token budget");
      return { ok: true, markdown: compiled.markdown, diagnostics: publicValue(diagnostics, this.#folders()) };
    }
    if (plan.kind === "verify") {
      const results = [...((op.partial ?? []) as Record<string, unknown>[])];
      for (let index = resumeFrom; index < plan.proofs.length; index++) {
        stopIfAborted(signal);
        const proof = plan.proofs[index]!;
        const checked = await verifyProof({ proof: join(this.#site.root, proof), siteRoot: this.#site.root });
        results.push({
          proof,
          ok: checked.failures.length === 0,
          files: checked.files,
          doctor: checked.doctor,
          failures: publicValue(checked.failures, this.#folders()),
        });
        op.partial = results;
        await progress("verify", index + 1, plan.proofs.length, "every proof matches the files it records");
      }
      const failures = results.reduce((count, item) => count + (item.ok === true ? 0 : 1), 0);
      return { ok: failures === 0, verified: results.length, failed: failures, results };
    }
    const events = plan.events;
    let last = replayTask(plan.taskId, []);
    let indexed = resumeFrom;
    for (; indexed < events.length; indexed++) {
      stopIfAborted(signal);
      const step = replayTask(plan.taskId, events.slice(0, indexed + 1));
      if (step.problems.length > 0) {
        last = step;
        break;
      }
      last = step;
      await progress("replay", indexed + 1, events.length, `the task replays to ${last.state ?? "no state"}`);
    }
    if (indexed >= events.length) last = replayTask(plan.taskId, events);
    return {
      ok: last.problems.length === 0,
      ...(last.state === undefined ? {} : { state: last.state }),
      problems: publicValue(last.problems, this.#folders()),
    };
  }

  async #prepare(kind: OperationKind, input: Record<string, unknown>): Promise<Plan> {
    if (kind === "pack") {
      const goal = typeof input.goal === "string" ? input.goal : "";
      const maxTokens = typeof input.maxTokens === "number" ? input.maxTokens : 0;
      if (maxTokens > MAX_PACK_TOKENS) {
        throw new McpError("budget-too-large", `maxTokens ${maxTokens} is over the limit of ${MAX_PACK_TOKENS}; ask for a smaller pack.`, {
          retryable: false,
          stage: "context",
          data: { limit: MAX_PACK_TOKENS },
        });
      }
      const parsed = parseContextRequest({
        version: 1,
        task: { goal, ...(typeof input.kind === "string" ? { kind: input.kind } : {}) },
        ...(Array.isArray(input.include) ? { include: input.include } : {}),
        ...(Array.isArray(input.exclude) ? { exclude: input.exclude } : {}),
        ...(typeof input.locale === "string" ? { constraints: { locale: input.locale } } : {}),
        budget: { maxTokens, ...(typeof input.reservedTokens === "number" ? { reservedTokens: input.reservedTokens } : {}) },
      });
      if (parsed.request === undefined) {
        throw new McpError("bad-request", parsed.problems.map((problem) => problem.message).join(" "), { retryable: false, stage: "context" });
      }
      return {
        kind,
        request: parsed.request,
        plan: { ...parsed.request } as Record<string, unknown>,
        total: this.#site.pages.length,
        expected: "a pack under the token budget",
      };
    }
    if (kind === "verify") {
      const proofs = await this.#proofs(input.proof);
      return { kind, proofs, plan: { proofs }, total: proofs.length, expected: "every proof matches the files it records" };
    }
    const task = typeof input.task === "object" && input.task !== null ? (input.task as Record<string, unknown>) : undefined;
    const taskId = typeof task?.id === "string" ? task.id : typeof input.taskId === "string" ? input.taskId : "";
    const events = Array.isArray(task?.events) ? (task.events as TaskEvent[]) : Array.isArray(input.events) ? (input.events as TaskEvent[]) : [];
    if (taskId === "" || events.length === 0) {
      throw new McpError("bad-request", "Replay needs `taskId` and a non-empty `events` list, or a task document with both.", {
        retryable: false,
        stage: "verify",
      });
    }
    return { kind, taskId, events, plan: { taskId, events }, total: events.length, expected: "the events replay to one task state" };
  }

  /** Proofs under `.mizzen/mcp/edits`, in path order, or the one the caller named. */
  async #proofs(one: unknown): Promise<string[]> {
    if (typeof one === "string" && one !== "") {
      const path = one.replace(/\\/g, "/").replace(/^\.\//, "");
      if (path.startsWith("../") || path.startsWith("/") || path.includes("\0")) {
        throw new McpError("path-outside-site", `"${one}" is not a path inside the site.`, { retryable: false, stage: "verify" });
      }
      return [path];
    }
    const dir = join(this.#site.root, ".mizzen", "mcp", "edits");
    const names = await readdir(dir).catch(() => [] as string[]);
    return names
      .filter((name) => name.endsWith(".proof.json"))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((name) => `.mizzen/mcp/edits/${name}`);
  }

  #event(op: StoredOperation, stage: string, completed: number, total: number, expected: string): StoredEvent {
    op.lastSeq += 1;
    const event: StoredEvent = { seq: op.lastSeq, stage, completed, total, expected };
    if (op.events.length >= this.#limits.maxEventsPerOperation) {
      op.events.shift();
      op.dropped += 1;
    }
    op.events.push(event);
    return event;
  }

  #emit(op: StoredOperation, event: StoredEvent): void {
    if (op.progressToken === undefined || this.notify === undefined) return;
    this.notify({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: {
        progressToken: op.progressToken,
        progress: event.completed,
        total: event.total,
        message: `${event.stage}: ${event.completed}/${event.total}; expected ${event.expected}`,
        stage: event.stage,
        expected: event.expected,
      },
    });
  }

  #terminal(op: StoredOperation): boolean {
    return op.status !== "running";
  }

  #prune(internal: InternalSession): void {
    const excess = internal.file.operations.length - this.#limits.maxOperationRecords + 1;
    if (excess <= 0) return;
    const removable = internal.file.operations.filter((op) => op.status !== "running").slice(0, excess);
    const gone = new Set(removable.map((op) => op.id));
    internal.file.operations = internal.file.operations.filter((op) => !gone.has(op.id));
  }

  #view(op: StoredOperation): OperationView {
    return {
      operationId: op.id,
      kind: op.kind,
      status: op.status,
      stage: op.stage,
      work: { completed: op.completed, total: op.total },
      expected: op.expected,
      events: op.events.map((event) => ({ ...event })),
      dropped: op.dropped,
      snapshot: op.snapshot,
      resumed: op.resumed,
      ...(op.result === undefined ? {} : { result: op.result }),
      ...(op.error === undefined ? {} : { error: op.error }),
    };
  }

  async #saveReceipts(): Promise<void> {
    const body = JSON.stringify({ version: 1, receipts: this.#receipts ?? [] } satisfies ReceiptFile);
    this.#saving = this.#saving
      .then(async () => {
        await mkdir(this.#dir, { recursive: true });
        const target = join(this.#dir, "receipts.json");
        const temporary = `${target}.${process.pid}.${this.#writeSeq++}.tmp`;
        await writeFile(temporary, `${body}\n`, "utf8");
        await rename(temporary, target);
      })
      .catch(() => undefined);
    await this.#saving;
  }
}

type Plan =
  | { readonly kind: "pack"; readonly request: ContextRequest; readonly plan: Record<string, unknown>; readonly total: number; readonly expected: string }
  | { readonly kind: "verify"; readonly proofs: string[]; readonly plan: Record<string, unknown>; readonly total: number; readonly expected: string }
  | {
      readonly kind: "replay";
      readonly taskId: string;
      readonly events: TaskEvent[];
      readonly plan: Record<string, unknown>;
      readonly total: number;
      readonly expected: string;
    };

function planOf(op: StoredOperation): Plan {
  const plan = op.plan ?? {};
  if (op.kind === "pack") {
    const request = parseContextRequest(plan).request;
    if (request === undefined) throw new McpError("bad-plan", "The stored pack request cannot be read again.", { retryable: false, stage: "context" });
    return { kind: "pack", request, plan, total: op.total, expected: op.expected };
  }
  if (op.kind === "verify") {
    const proofs = Array.isArray(plan.proofs) ? plan.proofs.filter((proof): proof is string => typeof proof === "string") : [];
    return { kind: "verify", proofs, plan, total: op.total, expected: op.expected };
  }
  const events = Array.isArray(plan.events) ? (plan.events as TaskEvent[]) : [];
  return { kind: "replay", taskId: String(plan.taskId ?? ""), events, plan, total: op.total, expected: op.expected };
}

function stopIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new McpError("cancelled", "The operation was cancelled at a safe boundary.", { retryable: true, stage: "operation" });
}

function isOperation(value: unknown): value is StoredOperation {
  if (typeof value !== "object" || value === null) return false;
  const op = value as Partial<StoredOperation>;
  return (
    typeof op.id === "string" &&
    (op.kind === "pack" || op.kind === "verify" || op.kind === "replay") &&
    typeof op.status === "string" &&
    ["running", "succeeded", "failed", "cancelled", "interrupted"].includes(op.status) &&
    Array.isArray(op.events) &&
    typeof op.total === "number" &&
    typeof op.completed === "number" &&
    typeof op.lastSeq === "number" &&
    typeof op.dropped === "number" &&
    typeof op.snapshot === "string" &&
    typeof op.owner === "string" &&
    typeof op.pid === "number" &&
    typeof op.stage === "string" &&
    typeof op.expected === "string"
  );
}

function isReceipt(value: unknown): value is ReceiptRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<ReceiptRecord>;
  return typeof record.key === "string" && typeof record.payloadHash === "string" && typeof record.session === "string" && typeof record.id === "string" && typeof record.result === "object" && record.result !== null;
}
