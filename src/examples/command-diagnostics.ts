import type { Diagnostic, SourcePos } from "../contracts/index.ts";
import type { CheckedCommand } from "./command-checks.ts";

/**
 * Turns the results of a page's command checks into findings at the blocks that hold the commands.
 *
 * A check names a repository test, and a result names a test and how it ended. A passing result adds no finding. A
 * failing one is an error at the example's span, carrying the test's output. A check with no result, or a result that
 * says the test did not run, is an `info` finding at the same span, so a block that was never verified is never shown
 * as passing. Results are matched to checks by test path, so one test can prove several blocks and every block gets
 * its own finding.
 */

/** How a command check's repository test ended. */
export type CommandTestState = "passed" | "failed" | "not-run";

/** One repository test's result, matched to the checks that name its path. */
export interface CommandTestResult {
  /** The repository test the result is for, relative to the repository root. */
  readonly test: string;
  /** Whether the test passed, failed, or did not run. */
  readonly state: CommandTestState;
  /** What the test reported, such as its failure output or why it did not run. */
  readonly detail?: string;
}

/** Stable id of the finding for a command check whose test failed. */
export const COMMAND_CHECK_FAILED_ID = "command-check-failed";

/** Stable id of the finding for a command check whose test did not run. */
export const COMMAND_CHECK_NOT_RUN_ID = "command-check-not-run";

/** The block's span, or `undefined` when its example was parsed without a page. */
function posOf(check: CheckedCommand): SourcePos | undefined {
  const { file, line, column, endLine, endColumn } = check.example.pos;
  return file === undefined ? undefined : { file, line, column, endLine, endColumn };
}

/** Names the block, and its file and line when the example has a page. */
function where(check: CheckedCommand): string {
  const pos = posOf(check);
  return pos === undefined
    ? `block "${check.example.id}"`
    : `block "${check.example.id}" at ${pos.file}:${pos.line}`;
}

/** The detail after a colon, or nothing when the test reported none. */
function because(detail: string | undefined): string {
  return detail === undefined || detail === "" ? "" : `: ${detail}`;
}

/** One finding per check, in check order: errors for failures and `info` for blocks that did not run. */
export function commandDiagnostics(
  checks: readonly CheckedCommand[],
  results: readonly CommandTestResult[],
): readonly Diagnostic[] {
  const byTest = new Map<string, CommandTestResult>();
  for (const result of results) byTest.set(result.test, result);

  const diagnostics: Diagnostic[] = [];
  for (const check of checks) {
    const result = byTest.get(check.test);
    if (result?.state === "passed") continue;

    const pos = posOf(check);
    if (result === undefined || result.state === "not-run") {
      const reason = result === undefined ? `no result was reported for ${check.test}` : because(result.detail);
      diagnostics.push({
        id: COMMAND_CHECK_NOT_RUN_ID,
        severity: "info",
        message: `The command check for ${where(check)} was not run${reason}.`,
        ...(pos === undefined ? {} : { pos }),
        help: `Run ${check.test} so the block's command is verified.`,
      });
      continue;
    }

    diagnostics.push({
      id: COMMAND_CHECK_FAILED_ID,
      severity: "error",
      message: `The command check for ${where(check)} failed in ${check.test}${because(result.detail)}.`,
      ...(pos === undefined ? {} : { pos }),
      help: "Fix the block's command or the test that proves it, then run the check again.",
    });
  }
  return diagnostics;
}
