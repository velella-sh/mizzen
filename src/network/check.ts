/** `mizzen network check <file>`: checks one local network file and prints each problem with its line. It fetches nothing. */
import { readFile } from "node:fs/promises";
import { parseNetwork, type NetworkProblem } from "./file.ts";

/** What {@link checkNetworkFile} found. */
export interface NetworkCheckResult {
  /** 0 for a valid file, 1 for any problem, 2 when the file cannot be read. */
  readonly code: number;
  /** One printable line per problem, `file:line:column: id: message`, in file order. */
  readonly lines: readonly string[];
  readonly problems: readonly NetworkProblem[];
  /** How many projects the file lists, when it is valid. */
  readonly projects?: number;
}

/** Formats a problem the way a compiler does, so editors can jump to it. */
export function formatProblem(file: string, problem: NetworkProblem): string {
  return `${file}:${problem.line}:${problem.column}: ${problem.id}: ${problem.message}`;
}

/** Checks network file text; `file` names it in the printed lines. */
export function checkNetworkText(text: string, file: string): NetworkCheckResult {
  const parsed = parseNetwork(text);
  const problems = [...parsed.problems].sort((a, b) => a.line - b.line || a.column - b.column || (a.id < b.id ? -1 : 1));
  return {
    code: problems.length === 0 ? 0 : 1,
    lines: problems.map((problem) => formatProblem(file, problem)),
    problems,
    ...(problems.length === 0 && parsed.network !== undefined ? { projects: parsed.network.projects.length } : {}),
  };
}

/** Reads the local file at `path` and checks it. */
export async function checkNetworkFile(path: string): Promise<NetworkCheckResult> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { code: 2, lines: [`${path}: cannot read the network file: ${detail}`], problems: [] };
  }
  return checkNetworkText(text, path);
}
