/**
 * The agent CLI's output contract: stdout carries one result document, stderr carries every sentence a
 * person reads.
 *
 * `--format json` writes exactly one JSON document and nothing else to stdout. A refusal is still a
 * document, with `ok: false` and every problem's JSON Pointer, so a client never has to parse a
 * sentence. Diagnostics are repeated on stderr for a human; they never appear on stdout.
 */
import type { TaskProblem } from "../contracts/task.ts";

/** What an agent command prints: one JSON document, a human summary, or JSON Lines (run only). */
export type AgentFormat = "json" | "text" | "ndjson";

/** Where an agent command writes; `main` passes the CLI's own streams. */
export interface AgentIo {
  readonly log: (message: string) => void;
  readonly write: (text: string) => void;
  readonly error: (message: string) => void;
  /** Reads stdin for `--stdin`; defaults to the process's stream, left open after the read. */
  readonly readStdin?: () => Promise<string>;
}

/** The failure document every refused command writes. */
export function failureDocument(command: string, problems: readonly TaskProblem[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: 1, ok: false, command, problems: [...problems], ...extra };
}

/** Prints diagnostics to stderr, one line per problem, on stdout only the chosen document. */
export function refuse(
  io: AgentIo,
  format: AgentFormat,
  command: string,
  problems: readonly TaskProblem[],
  exitCode: number,
  extra: Record<string, unknown> = {},
): number {
  for (const problem of problems) {
    io.error(`mizzen: ${problem.path === "" ? "/" : problem.path}: ${problem.code}: ${problem.message}`);
  }
  if (format !== "text") {
    io.write(`${JSON.stringify(failureDocument(command, problems, extra), null, 2)}\n`);
  }
  return exitCode;
}

/** Writes a success document to stdout, or a one-line human summary in text format. */
export function emit(io: AgentIo, format: AgentFormat, document: Record<string, unknown>, summary: string): number {
  io.write(format === "text" ? `${summary}\n` : `${JSON.stringify(document, null, 2)}\n`);
  return 0;
}
