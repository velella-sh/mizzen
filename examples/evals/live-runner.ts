/**
 * A live evaluation adapter: the same {@link EvalRunner} seam, with the model outside the engine.
 *
 * This file adds no provider SDK, no API key, and no network client. It starts one external program,
 * named by `MIZZEN_EVAL_AGENT`, which reads one JSON request on stdin and writes one
 * `EvalAgentOutput` on stdout. Everything the engine needs to score a run stays deterministic; only
 * this process is live, and only when a person runs it.
 */
import { spawn } from "node:child_process";
import type { EvalAgentOutput } from "../../src/contracts/evals.ts";
import type { EvalRunner, EvalRunnerInput } from "../../src/evals/runner.ts";

/** How the adapter is configured: the program, its tools, and the pin it records. */
export interface LiveRunnerOptions {
  /** Stable adapter id; pin it in the suite when an old report must stay comparable. */
  readonly id?: string;
  readonly version?: string;
  /** The model name this adapter records; it says nothing about how the program reaches it. */
  readonly model?: string;
  /** The external program; defaults to `MIZZEN_EVAL_AGENT`. */
  readonly command?: string;
  readonly args?: readonly string[];
  /** The tool versions the program provides, checked against the suite's pins. */
  readonly tools?: readonly { readonly name: string; readonly version: string }[];
  readonly timeoutMs?: number;
}

/** Reads stdout and stderr while the program runs, without leaking either into the report. */
function runProcess(
  command: string,
  args: readonly string[],
  request: unknown,
  timeoutMs: number,
): Promise<EvalAgentOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"], timeout: timeoutMs });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => reject(new Error(`${command}: ${error.message}`)));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${command} exited ${code}: ${stderr.trim().slice(0, 500)}`));
        return;
      }
      try {
        const output = JSON.parse(stdout) as EvalAgentOutput;
        if (!Array.isArray(output.pages) || !Array.isArray(output.toolCalls) || output.usage === undefined) {
          throw new Error("the output needs pages, symbols, toolCalls, and usage");
        }
        resolve(output);
      } catch (error) {
        reject(new Error(`${command}: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

/** The live adapter. It throws before a run when no program is configured. */
export function liveRunner(options: LiveRunnerOptions = {}): EvalRunner {
  const command = options.command ?? process.env["MIZZEN_EVAL_AGENT"];
  if (command === undefined || command.trim() === "") {
    throw new Error("set MIZZEN_EVAL_AGENT to the program that answers one evaluation case");
  }
  return {
    id: options.id ?? "live",
    version: options.version ?? "1",
    ...(options.model === undefined ? {} : { model: options.model }),
    tools: options.tools ?? [
      { name: "context", version: "1" },
      { name: "edit", version: "1" },
      { name: "transaction", version: "1" },
      { name: "verification", version: "1" },
      { name: "interaction", version: "1" },
      { name: "permission", version: "1" },
    ],
    async run(input: EvalRunnerInput) {
      return runProcess(command, options.args ?? [], input, options.timeoutMs ?? 300_000);
    },
  };
}
