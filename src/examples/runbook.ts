/**
 * Runs a multi-step runbook (#1333).
 *
 * A runbook is a group of `step` blocks that share a `runbook="name"`. Each step is a shell command, and each step runs
 * in the same session folder, in declared order, so a later step sees what an earlier one wrote. A runbook is strict:
 *
 * - Every command must be in the allowlist. A step that runs a command outside it is refused before anything runs, and
 *   the runbook stops there. The allowlist is the runbook's own, so a site states exactly what its steps may do.
 * - A step may declare a `precondition`: a command that must exit zero before the step runs. A failed precondition stops
 *   the runbook before the step, with a finding that names it.
 * - A step's expected output is compared under the documented whitespace rule; a mismatch stops the runbook.
 *
 * The first step that fails (refused, precondition, non-zero exit, or wrong output) stops the runbook before the next
 * step, so a later step never runs against a half-finished state. Every step that ran, and the one that stopped it,
 * appears in the result, so the evidence says exactly how far the runbook got.
 */
import type { OutputMatch } from "./match.ts";
import { matchOutput } from "./match.ts";
import type { BlockResult } from "./session.ts";
import { runSession } from "./session.ts";

/** One runbook step. */
export interface RunbookStep {
  /** The step block's id. */
  readonly id: string;
  /** The shell command the step runs. */
  readonly command: string;
  /** A command that must exit zero before the step runs. */
  readonly precondition?: string;
  /** The output the step should print. */
  readonly expected?: string;
  /** How the expected output is compared; default `exact`. */
  readonly expectedMatch?: OutputMatch;
}

/** What a runbook declares and the limits it runs under. */
export interface Runbook {
  /** The runbook's name, the `runbook="..."` attribute the steps share. */
  readonly name: string;
  /** Every command the steps may run. A step's command must be one of these. */
  readonly allowed: readonly string[];
  /** The steps, in declared order. */
  readonly steps: readonly RunbookStep[];
}

/** The limits a runbook run applies. */
export interface RunbookLimits {
  readonly timeoutMs: number;
  readonly memoryMb: number;
  readonly network: "deny" | "allow";
}

/** One step's outcome. */
export interface RunbookStepResult {
  readonly id: string;
  /** `passed`, `refused` (not allowlisted), `precondition` (its precondition failed), `failed` (non-zero exit), or
   * `mismatch` (wrong output). */
  readonly status: "passed" | "refused" | "precondition" | "failed" | "mismatch";
  /** The step's own output, when it ran. */
  readonly stdout: string;
  readonly stderr: string;
  /** For a `mismatch`, the expected and actual output as compared. */
  readonly expected?: string;
  readonly actual?: string;
  /** For a `precondition`, the reason it failed. */
  readonly detail?: string;
}

/** The runbook's result. */
export interface RunbookResult {
  readonly name: string;
  readonly steps: readonly RunbookStepResult[];
  /** True only when every step passed and every step ran. */
  readonly ok: boolean;
  /** The index of the step that stopped the runbook, when one did. */
  readonly stoppedAt?: number;
}

/** The stable id of the finding for a runbook step that did not pass. */
export const RUNBOOK_STEP_ID = "runbook-step";

/** The bare command name of a shell command line: the first word, without a path. */
export function commandNameOf(command: string): string | undefined {
  const match = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*([^\s;|&()<>]+)/.exec(command);
  if (!match) return undefined;
  const word = match[1]!;
  return word.slice(word.lastIndexOf("/") + 1);
}

/** True when `command` is in `allowed`: its first word, or the whole command line, must be named. */
export function isAllowed(command: string, allowed: readonly string[]): boolean {
  const trimmed = command.trim();
  if (allowed.includes(trimmed)) return true;
  const name = commandNameOf(trimmed);
  return name !== undefined && allowed.includes(name);
}

/** Runs one shell command in the session, returning its raw result. */
async function shell(command: string, limits: RunbookLimits, id: string): Promise<BlockResult> {
  const result = await runSession({ blocks: [{ id, lang: "bash", code: command }], limits, stopOnFailure: true });
  return result.blocks[0]!;
}

/**
 * Runs a runbook. Every step's command is checked against the allowlist first: the runbook refuses at the first
 * disallowed step and runs nothing past it, so a refusal never has a side effect. Then each step's precondition, exit
 * code, and expected output are checked in that order, and the first failure stops the runbook.
 */
export async function runRunbook(runbook: Runbook, limits: RunbookLimits): Promise<RunbookResult> {
  const steps: RunbookStepResult[] = [];
  for (let index = 0; index < runbook.steps.length; index++) {
    const step = runbook.steps[index]!;
    if (!isAllowed(step.command, runbook.allowed)) {
      steps.push({ id: step.id, status: "refused", stdout: "", stderr: `The step's command is not in the runbook's allowlist.\n` });
      return { name: runbook.name, steps, ok: false, stoppedAt: index };
    }
    if (step.precondition !== undefined) {
      if (!isAllowed(step.precondition, runbook.allowed)) {
        steps.push({ id: step.id, status: "refused", stdout: "", stderr: "", detail: `The precondition "${step.precondition}" is not in the allowlist.` });
        return { name: runbook.name, steps, ok: false, stoppedAt: index };
      }
      const pre = await shell(step.precondition, limits, `${step.id}:precondition`);
      if (pre.exitCode !== 0) {
        steps.push({ id: step.id, status: "precondition", stdout: pre.stdout, stderr: pre.stderr, detail: `The precondition "${step.precondition}" exited ${pre.exitCode === null ? "without a status" : pre.exitCode}.` });
        return { name: runbook.name, steps, ok: false, stoppedAt: index };
      }
    }

    const ran = await shell(step.command, limits, step.id);
    if (ran.exitCode !== 0 || !ran.ok) {
      steps.push({ id: step.id, status: "failed", stdout: ran.stdout, stderr: ran.stderr });
      return { name: runbook.name, steps, ok: false, stoppedAt: index };
    }
    if (step.expected !== undefined) {
      const matched = matchOutput(step.expected, ran.stdout, step.expectedMatch ?? "exact");
      if (!matched.ok) {
        steps.push({ id: step.id, status: "mismatch", stdout: ran.stdout, stderr: ran.stderr, expected: matched.expected, actual: matched.actual });
        return { name: runbook.name, steps, ok: false, stoppedAt: index };
      }
    }
    steps.push({ id: step.id, status: "passed", stdout: ran.stdout, stderr: ran.stderr });
  }
  return { name: runbook.name, steps, ok: true };
}

/** Groups `step` blocks into runbooks by their `runbook` attribute, in first-declared order. */
export function runbooksOf(
  steps: readonly { readonly id: string; readonly runbook?: string; readonly code: string; readonly precondition?: string; readonly expected?: string | null; readonly stdoutMatch?: OutputMatch }[],
  allowed: readonly string[],
): Runbook[] {
  const byName = new Map<string, RunbookStep[]>();
  for (const step of steps) {
    const name = step.runbook ?? "default";
    const list = byName.get(name) ?? [];
    list.push({
      id: step.id,
      command: step.code,
      ...(step.precondition === undefined ? {} : { precondition: step.precondition }),
      ...(step.expected === null || step.expected === undefined ? {} : { expected: step.expected }),
      ...(step.stdoutMatch === undefined ? {} : { expectedMatch: step.stdoutMatch }),
    });
    byName.set(name, list);
  }
  return [...byName].map(([name, runbookSteps]) => ({ name, allowed, steps: runbookSteps }));
}
