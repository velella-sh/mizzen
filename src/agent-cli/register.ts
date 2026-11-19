/**
 * `agent task register`: one task from a file or stdin.
 *
 * The contract is parsed and registered in memory first. Only a valid registration writes, and a
 * repeat with the same idempotency key returns the existing document without writing again: the task
 * id is the SHA-256 of the key, so the same request always addresses the same file. Invalid input
 * names its JSON Pointer and leaves `.mizzen/agent/` absent.
 */
import { registerTask } from "../tasks/register.ts";
import type { ContractSource } from "./input.ts";
import { readContract } from "./input.ts";
import { emit, refuse, type AgentFormat, type AgentIo } from "./io.ts";
import { readTasks, taskPath, writeRecord } from "./store.ts";

/** What `agent task register` reads and where it writes. */
export interface RegisterOptions {
  readonly root: string;
  readonly source: ContractSource;
  readonly format: AgentFormat;
}

/** Registers one task and prints the versioned result. */
export async function registerCommand(options: RegisterOptions, io: AgentIo): Promise<number> {
  const read = await readContract(options.source, io);
  if (read.problems.length > 0) return refuse(io, options.format, "agent.task.register", read.problems, 2);

  const store = await readTasks(options.root);
  if (store.problems.length > 0) {
    return refuse(io, options.format, "agent.task.register", store.problems, 1);
  }

  const result = registerTask(read.value, { existing: store.tasks });
  if (result.task === undefined) {
    const conflict = result.problems.some((problem) => problem.code === "task.idempotency-conflict");
    return refuse(io, options.format, "agent.task.register", result.problems, conflict ? 1 : 2);
  }

  const task = result.task;
  const writes: string[] = [];
  if (result.created) {
    await writeRecord(options.root, taskPath(task.id), task);
    writes.push(taskPath(task.id));
  }

  const document = {
    version: 1,
    ok: true,
    command: "agent.task.register",
    created: result.created,
    taskId: task.id,
    state: task.state,
    task,
    writes,
  };
  const summary = result.created
    ? `mizzen: registered task ${task.id} in ${task.state}.`
    : `mizzen: task ${task.id} is already registered in ${task.state}; nothing was written.`;
  return emit(io, options.format, document, summary);
}
