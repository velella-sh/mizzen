/**
 * Reading a task contract from the one source the caller named: a file, or stdin.
 *
 * Both sources produce the same bytes and go through the same parser, so a document read from a file
 * and one piped on stdin register to the same task. Nothing is written here; read errors and malformed
 * JSON become problems with a path a caller can act on.
 */
import { readFile } from "node:fs/promises";
import type { TaskProblem } from "../contracts/task.ts";
import { readStandardInput } from "../cli/pack-request.ts";
import type { AgentIo } from "./io.ts";

/** Which source a task contract comes from. */
export interface ContractSource {
  /** A JSON file path; absent when reading stdin. */
  readonly file?: string;
  /** True for stdin. Exactly one of `file` and `stdin` is set. */
  readonly stdin: boolean;
}

/** The decoded contract, or every reason it cannot be read. */
export interface ContractRead {
  readonly value?: unknown;
  readonly problems: readonly TaskProblem[];
}

/** Reads a contract from the file or stdin the caller named. */
export async function readContract(source: ContractSource, io: AgentIo): Promise<ContractRead> {
  if (source.file === undefined && !source.stdin) {
    return {
      problems: [
        { path: "/file", code: "agent.source-missing", message: "Give a task file with `--file <path>` or read it from stdin with `--stdin`." },
      ],
    };
  }
  if (source.file !== undefined && source.stdin) {
    return {
      problems: [
        { path: "/file", code: "agent.source-conflict", message: "`--file` and `--stdin` name two sources; give exactly one." },
      ],
    };
  }

  let text: string;
  if (source.file === undefined) {
    try {
      text = await (io.readStdin ?? (() => readStandardInput()))();
    } catch (err) {
      return {
        problems: [
          { path: "", code: "agent.read", message: `cannot read stdin: ${err instanceof Error ? err.message : String(err)}` },
        ],
      };
    }
  } else {
    try {
      text = await readFile(source.file, "utf8");
    } catch (err) {
      return {
        problems: [
          { path: "/file", code: "agent.read", message: `cannot read the task from ${source.file}: ${err instanceof Error ? err.message : String(err)}` },
        ],
      };
    }
  }

  try {
    return { value: JSON.parse(text), problems: [] };
  } catch (err) {
    const where = source.file ?? "stdin";
    return {
      problems: [
        { path: "", code: "agent.json", message: `the task in ${where} is not valid JSON: ${err instanceof Error ? err.message : String(err)}` },
      ],
    };
  }
}
