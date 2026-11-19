/**
 * `agent task preview`, `run`, `status`, `resume`, and `cancel`: the read-only plan, the recorded run,
 * and the two ways to steer a paused task.
 *
 * A run compiles the task's context with the same compiler `mizzen pack --task` uses, estimates what it
 * spent, stops when an independent budget limit is exceeded, pauses when a human review is still
 * required, and otherwise records `verify`. It never edits a page. A repeat with the same task id
 * returns the recorded result instead of running again; `resume` moves a waiting or blocked task back
 * to `ready`, and `cancel` is terminal. Dry runs compile and report but write no state and change no
 * project file.
 *
 * The context pack is the "proposed change" surface: its fragments name the exact source files and
 * spans the agent would read, and the preview adds the scope references, required checks, and output
 * URLs a person can compare before anything runs.
 */
import { resolve } from "node:path";import type { Site } from "../contracts/content.ts";
import type { Diagnostic } from "../contracts/diagnostic.ts";
import type { TaskContract, TaskDocument, TaskProblem, TaskStatus } from "../contracts/task.ts";
import { compileTaskContext, ContextCompileError } from "../context/compile.ts";
import { buildModel } from "../model/build.ts";
import { requestIdOf, taskIdOf } from "../tasks/identity.ts";
import { cancelTask, transitionTask } from "../tasks/lifecycle.ts";
import { budgetReportOf, costOf, type AgentBudgetReport, type AgentCost } from "./cost.ts";
import { addEvent, ndjsonOf, progressOf, type AgentEvent } from "./events.ts";
import type { ContractSource } from "./input.ts";
import { readContract } from "./input.ts";
import { emit, refuse, type AgentFormat, type AgentIo } from "./io.ts";
import {
  approvalsPath,
  readApprovals,
  readRecord,
  readTask,
  readTasks,
  runPath,
  taskPath,
  writeApprovals,
  writeRecord,
  writeTextAtomic,
} from "./store.ts";
import { parseTaskContract } from "../tasks/contract.ts";

/** One run outcome, matching the control flow a client branches on. */
export type RunOutcome = "prepared" | "awaiting-approval" | "budget-exceeded" | "failed";

/** The recorded result of one run, so an identical request returns it instead of running again. */
export interface AgentRunRecord {
  readonly version: 1;
  readonly taskId: string;
  readonly requestId: string;
  /** The task state when the result was written; a later resume or cancel makes reuse unsafe. */
  readonly taskState: TaskStatus;
  readonly outcome: RunOutcome;
  /** The full document the first run wrote, with `reused` already set to false. */
  readonly result: Record<string, unknown>;
}

/** What `agent task preview` reads. */
export interface PreviewOptions {
  readonly root: string;
  readonly source: ContractSource;
  readonly format: AgentFormat;
}

/** What `agent task run` reads. */
export interface RunOptions {
  readonly root: string;
  readonly id: string;
  readonly dryRun: boolean;
  readonly format: AgentFormat;
  /** Also write the events as JSON Lines to this file, resolved from the working directory. */
  readonly eventsFile?: string;
}

/** What `agent task resume` reads. */
export interface ResumeOptions {
  readonly root: string;
  readonly id: string;
  /** Approved review criterion ids, `all` for every review criterion, or undefined to approve none. */
  readonly approve?: readonly string[] | "all";
  readonly format: AgentFormat;
}

/** What `agent task cancel` reads. */
export interface CancelOptions {
  readonly root: string;
  readonly id: string;
  readonly reason: string;
  readonly format: AgentFormat;
}

/** What `agent task status` reads. */
export interface StatusOptions {
  readonly root: string;
  readonly id: string;
  readonly format: AgentFormat;
}

/** The identity and compiled context a preview prints. */
interface PreviewParts {
  readonly identity: { readonly id: string; readonly requestId: string; readonly goal: string };
  readonly proposedChanges: readonly { readonly kind: string; readonly ref: string }[];
  readonly requiredChecks: readonly Record<string, unknown>[];
  readonly affectedOutputs: readonly string[];
  readonly context: Record<string, unknown>;
  readonly cost: AgentCost;
  readonly budget: AgentBudgetReport;
  readonly stopReason: string | null;
}

/** Converts a build diagnostic into the same problem shape a client already parses. */
function problemOf(diagnostic: Diagnostic): TaskProblem {
  const where = diagnostic.pos === undefined ? "" : `${diagnostic.pos.file}:${diagnostic.pos.line}: `;
  return { path: "", code: diagnostic.id, message: `${where}${diagnostic.message}` };
}

/** The scope references, in kind order, as proposed changes. */
function proposedChanges(contract: TaskContract): readonly { readonly kind: string; readonly ref: string }[] {
  const changes: { kind: string; ref: string }[] = [];
  const add = (kind: string, refs: readonly string[]): void => {
    for (const ref of refs) changes.push({ kind, ref });
  };
  add("page", contract.scope.pages);
  add("block", contract.scope.blocks);
  add("collection", contract.scope.collections);
  add("symbol", contract.scope.symbols);
  add("file", contract.scope.files);
  return changes;
}

/** The checks and reviews the task's acceptance criteria require, in criterion order. */
function requiredChecks(contract: TaskContract): readonly Record<string, unknown>[] {
  return contract.acceptance.map((criterion) =>
    criterion.review === true
      ? { id: criterion.id, kind: "review", statement: criterion.statement }
      : { id: criterion.id, kind: "check", check: criterion.check, statement: criterion.statement },
  );
}

/** The page URLs, block holders, and files a task's scope can affect, without repeats. */
function affectedOutputs(site: Site, contract: TaskContract): readonly string[] {
  const outputs: string[] = [];
  const seen = new Set<string>();
  const add = (value: string): void => {
    if (seen.has(value)) return;
    seen.add(value);
    outputs.push(value);
  };
  for (const ref of contract.scope.pages) {
    const page = site.pages.find((candidate) => candidate.url === ref || candidate.source.file === ref);
    add(page === undefined ? ref : page.url);
  }
  for (const ref of contract.scope.blocks) {
    const page = site.pages.find((candidate) => candidate.blocks?.some((block) => block.id === ref));
    add(page === undefined ? `block:${ref}` : page.url);
  }
  for (const ref of contract.scope.collections) {
    const pages = site.pages.filter((candidate) => candidate.record?.collection === ref);
    if (pages.length === 0) add(`collection:${ref}`);
    for (const page of pages) add(page.url);
  }
  for (const ref of contract.scope.symbols) add(`symbol:${ref}`);
  for (const ref of contract.scope.files) add(ref);
  return outputs;
}

/** Compiles one contract into the parts a preview and a dry run share. */
async function previewParts(
  root: string,
  contract: TaskContract,
  io: AgentIo,
): Promise<{ readonly parts?: PreviewParts; readonly problems?: readonly TaskProblem[]; readonly exitCode?: number }> {
  const model = await buildModel(root);
  const errors = model.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) return { problems: errors.map(problemOf), exitCode: 1 };

  const diagnostics: Diagnostic[] = [];
  let compiled;
  try {
    compiled = await compileTaskContext(model.site, contract, {
      root,
      report: (diagnostic) => diagnostics.push(diagnostic),
    });
  } catch (err) {
    if (err instanceof ContextCompileError) {
      return {
        problems: err.problems.map((message) => ({ path: "", code: "context.request", message })),
        exitCode: 2,
      };
    }
    throw err;
  }
  for (const diagnostic of diagnostics) {
    io.error(`mizzen: ${diagnostic.pos === undefined ? "" : `${diagnostic.pos.file}:${diagnostic.pos.line}: `}${diagnostic.id}: ${diagnostic.message}`);
  }

  const cost = costOf(compiled.accounting.used, 1);
  const budget = budgetReportOf(contract.budget, { contextTokens: cost.contextTokens, toolCalls: cost.toolCalls, timeMs: cost.timeMs });
  return {
    parts: {
      identity: { id: taskIdOf(contract.idempotencyKey), requestId: requestIdOf(contract), goal: contract.goal },
      proposedChanges: proposedChanges(contract),
      requiredChecks: requiredChecks(contract),
      affectedOutputs: affectedOutputs(model.site, contract),
      context: {
        snapshot: compiled.snapshot,
        taskSnapshot: compiled.taskSnapshot,
        cacheKey: compiled.cache.key,
        fragments: compiled.fragments.length,
        omitted: compiled.omitted.length,
        tokens: compiled.accounting.used,
      },
      cost,
      budget,
      stopReason: budget.stops[0]?.reason ?? null,
    },
  };
}

/** The empty context a run that could not compile reports, so the shape stays the same. */
function emptyContext(task: TaskDocument): Record<string, unknown> {
  return { snapshot: null, taskSnapshot: task.snapshot.id, cacheKey: null, fragments: 0, omitted: 0, tokens: 0 };
}

/** The problem a run or steer reports when a task id is not in the store. */
function missingTask(id: string): readonly TaskProblem[] {
  return [
    {
      path: "/id",
      code: "agent.task-missing",
      message: `No task \`${id}\` is registered under .mizzen/agent/tasks; register it first or check the id.`,
    },
  ];
}

/** Prints a run result, including its events as JSON Lines when `--format ndjson` is chosen. */
function emitRun(io: AgentIo, format: AgentFormat, document: Record<string, unknown>, events: readonly AgentEvent[], exitCode: number, summary: string): number {
  if (format === "ndjson") {
    io.write(ndjsonOf(events, document));
    return exitCode;
  }
  if (format === "text") {
    io.write(`${summary}\n`);
    return exitCode;
  }
  io.write(`${JSON.stringify(document, null, 2)}\n`);
  return exitCode;
}

/** `agent task preview`: compile a contract and report what it would touch, writing nothing. */
export async function previewCommand(options: PreviewOptions, io: AgentIo): Promise<number> {
  const read = await readContract(options.source, io);
  if (read.problems.length > 0) return refuse(io, options.format, "agent.task.preview", read.problems, 2);
  const parsed = parseTaskContract(read.value);
  if (parsed.contract === undefined) return refuse(io, options.format, "agent.task.preview", parsed.problems, 2);

  const plan = await previewParts(options.root, parsed.contract, io);
  if (plan.parts === undefined) {
    return refuse(io, options.format, "agent.task.preview", plan.problems ?? [], plan.exitCode ?? 1);
  }
  const parts = plan.parts;
  const document = {
    version: 1,
    ok: true,
    command: "agent.task.preview",
    dryRun: true,
    task: parts.identity,
    proposedChanges: parts.proposedChanges,
    requiredChecks: parts.requiredChecks,
    affectedOutputs: parts.affectedOutputs,
    context: parts.context,
    cost: parts.cost,
    budget: parts.budget,
    stopReason: parts.stopReason,
    writes: [],
  };
  const summary = `mizzen: preview ${parts.identity.id}: ${parts.proposedChanges.length} scope references, ${parts.requiredChecks.length} required checks, ${String(parts.context.fragments ?? 0)} fragments, ${parts.cost.contextTokens} tokens; nothing was written.`;
  return emit(io, options.format, document, summary);
}

/** `agent task run --dry-run`: the same plan, but for a registered task and with the run envelope. */
async function dryRun(root: string, task: TaskDocument, format: AgentFormat, io: AgentIo): Promise<number> {
  const plan = await previewParts(root, task, io);
  if (plan.parts === undefined) {
    return refuse(io, format, "agent.task.run", plan.problems ?? [], plan.exitCode ?? 1, { dryRun: true });
  }
  const parts = plan.parts;
  const events: AgentEvent[] = [];
  const document = {
    version: 1,
    ok: true,
    command: "agent.task.run",
    dryRun: true,
    outcome: "prepared" as RunOutcome,
    reused: false,
    task,
    resultRef: null,
    progress: progressOf(events),
    cost: parts.cost,
    budget: parts.budget,
    stopReason: parts.stopReason,
    context: parts.context,
    proposedChanges: parts.proposedChanges,
    requiredChecks: parts.requiredChecks,
    affectedOutputs: parts.affectedOutputs,
    writes: [],
  };
  return emitRun(io, format, document, events, 0, `mizzen: dry run ${task.id}: nothing was written.`);
}

/** Writes the events file the caller asked for, atomically. */
async function writeEvents(path: string, events: readonly AgentEvent[], document: Record<string, unknown>): Promise<void> {
  await writeTextAtomic(resolve(path), ndjsonOf(events, document));
}

/** `agent task run`: compile, budget, pause or prepare, and record the result once. */
export async function runCommand(options: RunOptions, io: AgentIo): Promise<number> {
  const store = await readTasks(options.root);
  if (store.problems.length > 0) return refuse(io, options.format, "agent.task.run", store.problems, 1);

  const task = await readTask(options.root, options.id);
  if (task === undefined) return refuse(io, options.format, "agent.task.run", missingTask(options.id), 1);

  if (options.dryRun) return dryRun(options.root, task, options.format, io);

  const recorded = await readRecord<AgentRunRecord>(options.root, runPath(task.id));
  if (
    recorded !== undefined &&
    recorded.version === 1 &&
    recorded.taskId === task.id &&
    recorded.taskState === task.state
  ) {
    const document = { ...recorded.result, reused: true };
    return emitRun(io, options.format, document, [], recorded.result.ok === true ? 0 : 1, `mizzen: task ${task.id} already ran; returning the recorded result.`);
  }

  let events = addEvent([], task.id, "start", null, task.state, `Run requested for task ${task.id}.`);
  let current = task;

  const move = (to: TaskStatus, reason: string, result?: string): readonly TaskProblem[] => {
    const moved = transitionTask(current, { to, reason, ...(result === undefined ? {} : { result }) });
    if (moved.task !== undefined) current = moved.task;
    return moved.problems;
  };
  const fail = async (problems: readonly TaskProblem[], message: string, context: Record<string, unknown>, cost = costOf(0, 1)): Promise<number> => {
    if (current.state !== "failed") {
      const problemsOfMove = move("failed", message);
      if (problemsOfMove.length > 0) return refuse(io, options.format, "agent.task.run", problemsOfMove, 1);
    }
    events = addEvent(events, task.id, "failure", "lifecycle", current.state, message);
    const budget = budgetReportOf(task.budget, { contextTokens: cost.contextTokens, toolCalls: cost.toolCalls, timeMs: cost.timeMs });
    const document = {
      version: 1,
      ok: false,
      command: "agent.task.run",
      dryRun: false,
      outcome: "failed" as RunOutcome,
      reused: false,
      task: current,
      resultRef: null,
      progress: progressOf(events),
      cost,
      budget,
      stopReason: budget.stops[0]?.reason ?? null,
      context,
      writes: [taskPath(task.id), runPath(task.id)],
      ...(problems.length === 0 ? {} : { problems }),
    };
    await writeRecord(options.root, taskPath(task.id), current);
    await writeRecord(options.root, runPath(task.id), { version: 1, taskId: task.id, requestId: task.requestId, taskState: current.state, outcome: "failed", result: document } satisfies AgentRunRecord);
    if (options.eventsFile !== undefined) await writeEvents(options.eventsFile, events, document);
    for (const problem of problems) io.error(`mizzen: ${problem.path === "" ? "/" : problem.path}: ${problem.code}: ${problem.message}`);
    return emitRun(io, options.format, document, events, 1, `mizzen: task ${task.id} failed: ${message}`);
  };

  if (current.state === "draft") {
    const problems = move("ready", "A run requested the task.");
    if (problems.length > 0) return refuse(io, options.format, "agent.task.run", problems, 1);
  }
  if (current.state === "verify") {
    return refuse(io, options.format, "agent.task.run", [{
      path: "/state",
      code: "agent.task-already-prepared",
      message: `Task \`${task.id}\` is already \`verify\` and has no recorded result to return; use \`agent task status\` or cancel it.`,
    }], 1);
  }
  if (current.state !== "running") {
    const problems = move("running", "A run requested the task.");
    if (problems.length > 0) return refuse(io, options.format, "agent.task.run", problems, 1);
  }

  const model = await buildModel(options.root);
  const modelErrors = model.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (modelErrors.length > 0) {
    return fail(modelErrors.map(problemOf), "The site has build errors; the task cannot run.", emptyContext(task));
  }

  let compiled;
  try {
    compiled = await compileTaskContext(model.site, current, { root: options.root });
  } catch (err) {
    if (err instanceof ContextCompileError) {
      return fail(
        err.problems.map((message) => ({ path: "", code: "context.request", message })),
        "The task makes no valid context request.",
        emptyContext(task),
      );
    }
    throw err;
  }

  const cost = costOf(compiled.accounting.used, 1);
  const budget = budgetReportOf(task.budget, { contextTokens: cost.contextTokens, toolCalls: cost.toolCalls, timeMs: cost.timeMs });
  events = addEvent(
    events,
    task.id,
    "progress",
    "context",
    current.state,
    `Compiled ${compiled.fragments.length} fragments (${compiled.omitted.length} omitted) for ${compiled.accounting.used} estimated tokens.`,
  );
  const context = {
    snapshot: compiled.snapshot,
    taskSnapshot: compiled.taskSnapshot,
    cacheKey: compiled.cache.key,
    fragments: compiled.fragments.length,
    omitted: compiled.omitted.length,
    tokens: compiled.accounting.used,
  };

  if (budget.stops.length > 0) {
    const stopReason = budget.stops.map((stop) => stop.reason).join(" ");
    events = addEvent(events, task.id, "failure", "budget", current.state, stopReason);
    const moved = transitionTask(current, { to: "failed", reason: stopReason });
    if (moved.task === undefined) return refuse(io, options.format, "agent.task.run", moved.problems, 1);
    current = moved.task;
    const document = {
      version: 1,
      ok: false,
      command: "agent.task.run",
      dryRun: false,
      outcome: "budget-exceeded" as RunOutcome,
      reused: false,
      task: current,
      resultRef: null,
      progress: progressOf(events),
      cost,
      budget,
      stopReason,
      context,
      writes: [taskPath(task.id), runPath(task.id)],
    };
    await writeRecord(options.root, taskPath(task.id), current);
    await writeRecord(options.root, runPath(task.id), { version: 1, taskId: task.id, requestId: task.requestId, taskState: current.state, outcome: "budget-exceeded", result: document } satisfies AgentRunRecord);
    if (options.eventsFile !== undefined) await writeEvents(options.eventsFile, events, document);
    io.error(`mizzen: task ${task.id} stopped on budget: ${stopReason}`);
    return emitRun(io, options.format, document, events, 1, `mizzen: task ${task.id} stopped on budget: ${stopReason}`);
  }

  const approved = await readApprovals(options.root, task.id);
  const pending = task.acceptance.filter((criterion) => criterion.review === true && !approved.includes(criterion.id));
  if (pending.length > 0) {
    const reason = `Waiting for human review: ${pending.map((criterion) => criterion.id).join(", ")}.`;
    const moved = transitionTask(current, { to: "waiting", reason });
    if (moved.task === undefined) return refuse(io, options.format, "agent.task.run", moved.problems, 1);
    current = moved.task;
    events = addEvent(events, task.id, "approval-required", "acceptance", current.state, reason);
    events = addEvent(events, task.id, "finish", "lifecycle", current.state, "The run is paused until a person approves the review criteria.");
    const document = {
      version: 1,
      ok: true,
      command: "agent.task.run",
      dryRun: false,
      outcome: "awaiting-approval" as RunOutcome,
      reused: false,
      task: current,
      resultRef: null,
      progress: progressOf(events),
      cost,
      budget,
      stopReason: null,
      context,
      writes: [taskPath(task.id), runPath(task.id)],
    };
    await writeRecord(options.root, taskPath(task.id), current);
    await writeRecord(options.root, runPath(task.id), { version: 1, taskId: task.id, requestId: task.requestId, taskState: current.state, outcome: "awaiting-approval", result: document } satisfies AgentRunRecord);
    if (options.eventsFile !== undefined) await writeEvents(options.eventsFile, events, document);
    return emitRun(io, options.format, document, events, 0, `mizzen: task ${task.id} is waiting for review: ${pending.map((criterion) => criterion.id).join(", ")}.`);
  }

  const resultRef = `context:${compiled.cache.key}`;
  const moved = transitionTask(current, { to: "verify", reason: "The task context is compiled and ready for verification.", result: resultRef });
  if (moved.task === undefined) return refuse(io, options.format, "agent.task.run", moved.problems, 1);
  current = moved.task;
  events = addEvent(events, task.id, "finish", "lifecycle", current.state, `Context prepared as ${resultRef}.`);
  const document = {
    version: 1,
    ok: true,
    command: "agent.task.run",
    dryRun: false,
    outcome: "prepared" as RunOutcome,
    reused: false,
    task: current,
    resultRef,
    progress: progressOf(events),
    cost,
    budget,
    stopReason: null,
    context,
    writes: [taskPath(task.id), runPath(task.id)],
  };
  await writeRecord(options.root, taskPath(task.id), current);
  await writeRecord(options.root, runPath(task.id), { version: 1, taskId: task.id, requestId: task.requestId, taskState: current.state, outcome: "prepared", result: document } satisfies AgentRunRecord);
  if (options.eventsFile !== undefined) await writeEvents(options.eventsFile, events, document);
  return emitRun(io, options.format, document, events, 0, `mizzen: task ${task.id} prepared ${compiled.fragments.length} fragments (${cost.contextTokens} tokens) and is ready for verification.`);
}

/** `agent task status`: the task, its last run, and its approvals. */
export async function statusCommand(options: StatusOptions, io: AgentIo): Promise<number> {
  const task = await readTask(options.root, options.id);
  if (task === undefined) return refuse(io, options.format, "agent.task.status", missingTask(options.id), 1);
  const run = await readRecord<AgentRunRecord>(options.root, runPath(task.id));
  const approvals = await readApprovals(options.root, task.id);
  const document = {
    version: 1,
    ok: true,
    command: "agent.task.status",
    task,
    run: run?.result ?? null,
    approvals,
  };
  return emit(io, options.format, document, `mizzen: task ${task.id} is ${task.state}; ${run === undefined ? "no run recorded" : `last run ${run.outcome}`}; ${approvals.length} approvals.`);
}

/** `agent task resume`: a waiting or blocked task returns to ready, with any approvals recorded. */
export async function resumeCommand(options: ResumeOptions, io: AgentIo): Promise<number> {
  const task = await readTask(options.root, options.id);
  if (task === undefined) return refuse(io, options.format, "agent.task.resume", missingTask(options.id), 1);

  const reviewIds = task.acceptance.filter((criterion) => criterion.review === true).map((criterion) => criterion.id);
  const requested = options.approve === "all" ? reviewIds : options.approve ?? [];
  const unknown = requested.filter((id) => !reviewIds.includes(id));
  if (unknown.length > 0) {
    return refuse(io, options.format, "agent.task.resume", [{
      path: "/approve",
      code: "agent.approval-unknown",
      message: `\`${unknown.join(", ")}\` is not a human-review criterion of task \`${task.id}\`; review criteria: ${reviewIds.length === 0 ? "none" : reviewIds.map((id) => `\`${id}\``).join(", ")}.`,
    }], 2);
  }

  const moved = transitionTask(task, { to: "ready", reason: "A person resumed the task." });
  if (moved.task === undefined) return refuse(io, options.format, "agent.task.resume", moved.problems, 1);
  if (requested.length > 0) await writeApprovals(options.root, task.id, requested);
  await writeRecord(options.root, taskPath(task.id), moved.task);
  const approvals = await readApprovals(options.root, task.id);
  const document = {
    version: 1,
    ok: true,
    command: "agent.task.resume",
    task: moved.task,
    approvals,
  };
  return emit(io, options.format, document, `mizzen: resumed task ${task.id} in ready${requested.length === 0 ? "" : ` with approvals: ${requested.join(", ")}`}.`);
}

/** `agent task cancel`: terminal, idempotent in its conflict, and never destructive of history. */
export async function cancelCommand(options: CancelOptions, io: AgentIo): Promise<number> {
  const task = await readTask(options.root, options.id);
  if (task === undefined) return refuse(io, options.format, "agent.task.cancel", missingTask(options.id), 1);
  const canceled = cancelTask(task, options.reason);
  if (canceled.task === undefined) return refuse(io, options.format, "agent.task.cancel", canceled.problems, 1);
  await writeRecord(options.root, taskPath(task.id), canceled.task);
  const document = {
    version: 1,
    ok: true,
    command: "agent.task.cancel",
    task: canceled.task,
  };
  return emit(io, options.format, document, `mizzen: canceled task ${task.id}.`);
}

/** The approvals file path, exported so status and tests can name it. */
export { approvalsPath };
