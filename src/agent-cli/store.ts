/**
 * The agent CLI's local state: registered tasks, run records, and review approvals under
 * `<site>/.mizzen/agent/`.
 *
 * A task's id is the SHA-256 of its idempotency key, so it never contains a local path, a clock, or a
 * display name: two machines that register the same key address the same file name. Every write goes
 * to a temporary folder inside the same parent and then one rename, so a reader never sees a partial
 * document and a failed write leaves the previous file byte-identical.
 */
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TaskDocument, TaskProblem } from "../contracts/task.ts";
import { replayTask, TASK_STATUSES } from "../tasks/lifecycle.ts";

/** Folder the agent state lives in, relative to the site root. */
export const AGENT_STATE_DIR = ".mizzen/agent";
/** Registered task documents. */
export const AGENT_TASKS_DIR = `${AGENT_STATE_DIR}/tasks`;
/** The latest run result of each task, so a repeat returns the first result. */
export const AGENT_RUNS_DIR = `${AGENT_STATE_DIR}/runs`;
/** Review approvals recorded by `agent task resume --approve`. */
export const AGENT_APPROVALS_DIR = `${AGENT_STATE_DIR}/approvals`;

/** One recorded approval of a task's human-review criteria. */
export interface AgentApprovalRecord {
  readonly version: 1;
  readonly taskId: string;
  /** Approved criterion ids, sorted by code point so the file is deterministic. */
  readonly approved: readonly string[];
}

/** Every task the store can read, with the file that would not parse. */
export interface AgentTaskList {
  readonly tasks: readonly TaskDocument[];
  readonly problems: readonly TaskProblem[];
}

/** The relative path of a task document, with forward slashes. */
export function taskPath(id: string): string {
  return `${AGENT_TASKS_DIR}/${id}.json`;
}

/** The relative path of a run record. */
export function runPath(id: string): string {
  return `${AGENT_RUNS_DIR}/${id}.json`;
}

/** The relative path of an approvals record. */
export function approvalsPath(id: string): string {
  return `${AGENT_APPROVALS_DIR}/${id}.json`;
}

/** True for a plain JSON object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads and checks one task document, or names why it cannot be used. */
function taskOf(value: unknown, file: string): { readonly task?: TaskDocument; readonly problems: readonly TaskProblem[] } {
  if (!isObject(value)) {
    return {
      problems: [{ path: "", code: "agent.store-corrupt", message: `${file} is not a task document.` }],
    };
  }
  const { version, id, requestId, state, events } = value;
  if (
    version !== 1 ||
    typeof id !== "string" ||
    typeof requestId !== "string" ||
    typeof state !== "string" ||
    !(TASK_STATUSES as readonly string[]).includes(state) ||
    !Array.isArray(events)
  ) {
    return {
      problems: [{ path: "", code: "agent.store-corrupt", message: `${file} is not a version 1 task document.` }],
    };
  }
  const replay = replayTask(id, events as TaskDocument["events"]);
  if (replay.problems.length > 0) {
    return {
      problems: replay.problems.map((problem) => ({
        ...problem,
        path: problem.path,
        code: "agent.store-corrupt",
        message: `${file} ${problem.path === "" ? "/" : problem.path}: ${problem.message}`,
      })),
    };
  }
  return { task: value as unknown as TaskDocument, problems: [] };
}

/** Reads every registered task, in file-name order, and names each file that is not a task. */
export async function readTasks(root: string): Promise<AgentTaskList> {
  const folder = join(root, AGENT_TASKS_DIR);
  let names: string[];
  try {
    names = await readdir(folder);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { tasks: [], problems: [] };
    throw err;
  }
  const tasks: TaskDocument[] = [];
  const problems: TaskProblem[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(join(folder, name), "utf8"));
    } catch (err) {
      problems.push({
        path: "",
        code: "agent.store-corrupt",
        message: `${AGENT_TASKS_DIR}/${name} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    const read = taskOf(value, `${AGENT_TASKS_DIR}/${name}`);
    problems.push(...read.problems);
    if (read.task !== undefined) tasks.push(read.task);
  }
  return { tasks, problems };
}

/** Reads one task by id, or `undefined` when the store holds none. */
export async function readTask(root: string, id: string): Promise<TaskDocument | undefined> {
  let text: string;
  try {
    text = await readFile(join(root, taskPath(id)), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  return taskOf(JSON.parse(text), taskPath(id)).task;
}

/** Reads a versioned JSON record, or `undefined` when it does not exist. */
export async function readRecord<T>(root: string, path: string): Promise<T | undefined> {
  let text: string;
  try {
    text = await readFile(join(root, path), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  return JSON.parse(text) as T;
}

/** Writes one JSON document atomically: a staging folder beside the target, then one rename. */
export async function writeRecord(root: string, path: string, value: unknown): Promise<void> {
  await writeTextAtomic(join(root, path), `${JSON.stringify(value, null, 2)}\n`);
}

/** Writes text atomically beside its target, so no reader sees a partial document. */
export async function writeTextAtomic(target: string, contents: string): Promise<void> {
  const folder = dirname(target);
  await mkdir(folder, { recursive: true });
  const staging = await mkdtemp(join(folder, ".mizzen-agent-"));
  try {
    const temp = join(staging, "payload");
    await writeFile(temp, contents, "utf8");
    await rename(temp, target);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Reads the approvals recorded for a task, or an empty list. */
export async function readApprovals(root: string, id: string): Promise<readonly string[]> {
  const record = await readRecord<AgentApprovalRecord>(root, approvalsPath(id));
  if (record === undefined || record.version !== 1 || record.taskId !== id || !Array.isArray(record.approved)) {
    return [];
  }
  return record.approved;
}

/** Records approved criterion ids, merged with the ones already recorded, in code-point order. */
export async function writeApprovals(root: string, id: string, approved: readonly string[]): Promise<AgentApprovalRecord> {
  const previous = await readApprovals(root, id);
  const all = [...new Set([...previous, ...approved])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const record: AgentApprovalRecord = { version: 1, taskId: id, approved: all };
  await writeRecord(root, approvalsPath(id), record);
  return record;
}
