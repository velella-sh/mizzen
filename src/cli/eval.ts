/**
 * `mizzen eval [suite] [--format text|json] [--out <file>] [--baseline <file>] [--package <pin>]`:
 * run one deterministic evaluation suite and print its report.
 *
 * The suite folder holds `suite.json` and the case files it names. The command never calls a model:
 * the reference adapter replays recorded outputs and drives the engine's compiler, transaction,
 * verifier, and handoff reader. A live adapter runs outside this command and outside `npm test`.
 *
 * `--baseline` records a report for comparison; a case whose pins changed is reported as
 * `incomparable` with the reason. Exit codes: 0 when the gate passes, 1 when a case fails or is
 * invalid, 2 for a usage error.
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { EvalReport } from "../contracts/evals.ts";
import { readEvalBaseline, runEvalSuite } from "../evals/index.ts";

/** Where the command prints. */
export interface EvalIo {
  readonly write: (message: string) => void;
  readonly error: (message: string) => void;
}

export const evalUsage = `Usage: mizzen eval [suite] [options]

Runs the evaluation suite in [suite] (default: evals) and prints its report.
  --format <format>   text (default) or json
  --out <file>        Write the report to this file instead of stdout
  --baseline <file>   Compare with a recorded baseline report
  --package <pin>     Package pin to record (default: source)
`;

/** One parsed invocation. */
interface EvalArgs {
  readonly suite: string;
  readonly format: "text" | "json";
  readonly out?: string;
  readonly baseline?: string;
  readonly package?: string;
}

/** Parses the arguments, or throws the sentence a person can act on. */
function parseEvalArgs(args: readonly string[]): EvalArgs {
  let suite = "evals";
  let format: "text" | "json" = "text";
  let out: string | undefined;
  let baseline: string | undefined;
  let packagePin: string | undefined;
  let positional = false;
  let index = 0;
  while (index < args.length) {
    const arg = args[index]!;
    const value = (): string => {
      const next = args[++index];
      if (next === undefined || next.startsWith("-")) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--format") {
      const raw = value();
      if (raw !== "text" && raw !== "json") throw new Error(`--format must be text or json, not ${raw}`);
      format = raw;
    } else if (arg === "--out") out = value();
    else if (arg === "--baseline") baseline = value();
    else if (arg === "--package") packagePin = value();
    else if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
    else if (!positional) {
      suite = arg;
      positional = true;
    } else throw new Error(`unexpected argument: ${arg}`);
    index += 1;
  }
  return {
    suite,
    format,
    ...(out === undefined ? {} : { out }),
    ...(baseline === undefined ? {} : { baseline }),
    ...(packagePin === undefined ? {} : { package: packagePin }),
  };
}

/** The text a person reads: one line per case, then the totals and the gate. */
export function formatEvalText(report: EvalReport): string {
  const lines = [`eval ${report.suite.id}@${report.suite.version}: runner ${report.run.runner.id} ${report.run.runner.version}`];
  for (const item of report.cases) {
    const score = item.status === "unavailable" ? "" : `  ${item.weighted.toFixed(3)}`;
    lines.push(`  ${item.id.padEnd(30)} ${item.status}${score}`);
    if (item.unavailable !== undefined) lines.push(`    ${item.unavailable}`);
    for (const finding of item.findings) lines.push(`    ${finding.code}: ${finding.message}`);
  }
  lines.push(
    `${report.totals.passed} passed, ${report.totals.failed} failed, ${report.totals.invalid} invalid, ${report.totals.unavailable} unavailable; ${report.totals.metrics.tokens} tokens, ${report.totals.metrics.toolCalls} tool calls`,
  );
  lines.push(report.gate.passed ? "gate: passed" : `gate: failed\n${report.gate.reasons.map((reason) => `  ${reason}`).join("\n")}`);
  if (report.baseline !== undefined) {
    lines.push(
      report.baseline.comparable
        ? `baseline: ${report.baseline.delta >= 0 ? "+" : ""}${report.baseline.delta.toFixed(3)} (${report.baseline.regressed.length} regressed)`
        : `baseline: incomparable (${report.baseline.reasons.join("; ")})`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Runs the command. */
export async function runEval(args: readonly string[], io: EvalIo): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    io.write(evalUsage);
    return 0;
  }
  let parsed: EvalArgs;
  try {
    parsed = parseEvalArgs(args);
  } catch (error) {
    io.error(`mizzen eval: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  try {
    const baseline = parsed.baseline === undefined ? undefined : await readEvalBaseline(resolve(parsed.baseline));
    const { report } = await runEvalSuite({
      suite: resolve(parsed.suite),
      ...(parsed.package === undefined ? {} : { package: parsed.package }),
      ...(baseline === undefined ? {} : { baseline }),
    });
    const text = parsed.format === "json" ? `${JSON.stringify(report, null, 2)}\n` : formatEvalText(report);
    if (parsed.out === undefined) io.write(text);
    else await writeFile(resolve(parsed.out), text, "utf8");
    return report.gate.passed ? 0 : 1;
  } catch (error) {
    io.error(`mizzen eval: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}
