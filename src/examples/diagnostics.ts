/**
 * The findings an executable example reports (#1327 – #1334).
 *
 * Each is anchored at the block's source span, so `formatText` prints a code frame at the fence, and each names the
 * block, the file and line, and what went wrong, so a reader can go from the finding to the exact block. Severity is a
 * `warning` by default and an `error` when the site sets `examples.failOnFailure`, so a failing example is reported
 * without failing every build unless the site asks for it.
 */
import type { Diagnostic, Severity } from "../contracts/diagnostic.ts";
import type { SourcePos } from "../contracts/source.ts";
import type { MarkdownExample } from "../markdown/plugins/example-fence.ts";
import type { OutputResult } from "./match.ts";
import { WHITESPACE_RULE } from "./match.ts";
import type { RunbookStepResult } from "./runbook.ts";
import type { ExampleTypeFinding } from "./type-check.ts";

/** Severity for a failed example: a warning unless the site asked to fail on failure. */
function severityOf(failOnFailure: boolean): Severity {
  return failOnFailure ? "error" : "warning";
}

/** The fence's span in the page's source. */
function posOf(example: MarkdownExample, file: string): SourcePos {
  return { file, line: example.pos.line, column: example.pos.column, endLine: example.pos.endLine, endColumn: example.pos.endColumn };
}

/** Escapes a value for one line, like the runner's own difference view. */
function quote(text: string): string {
  return JSON.stringify(text);
}

/** The finding for an output that did not match its expected fence. */
export function mismatchDiagnostic(
  options: { readonly failOnFailure?: boolean },
  example: MarkdownExample,
  file: string,
  stream: "stdout" | "stderr",
  result: OutputResult,
): Diagnostic {
  const problem =
    result.problem === "invalid-pattern"
      ? `its ${stream} pattern is not a valid regular expression`
      : result.problem === "no-match"
        ? `its ${stream} pattern did not match`
        : `its ${stream} differs`;
  const expectedText = result.difference === undefined ? result.expected : result.difference.expected;
  const actualText = result.difference === undefined ? result.actual : result.difference.actual;
  return {
    id: "example-failed",
    severity: severityOf(options.failOnFailure === true),
    message: `${example.id} at ${file}:${example.pos.line} failed: ${problem}: expected ${quote(expectedText)} but got ${quote(actualText)}.`,
    pos: posOf(example, file),
    help: `Update the expected ${stream}, or fix what the example prints. ${WHITESPACE_RULE}`,
  };
}

/** The finding for a block that exited non-zero or broke a limit. */
export function exitDiagnostic(
  options: { readonly failOnFailure?: boolean },
  example: MarkdownExample,
  file: string,
  outcome: { readonly exitCode: number | null; readonly violation?: string; readonly stderr: string },
): Diagnostic {
  const limit =
    outcome.violation === undefined || outcome.violation === "none"
      ? ""
      : outcome.violation === "timeout"
        ? " (the time limit stopped it)"
        : outcome.violation === "memory"
          ? " (the memory limit stopped it)"
          : outcome.violation === "output"
            ? " (the output limit stopped it)"
            : outcome.violation === "network"
              ? " (the network is disabled)"
              : outcome.violation === "filesystem"
                ? " (a write outside the folder was refused)"
                : outcome.violation === "command"
                  ? " (a denied command was refused)"
                  : ` (${outcome.violation})`;
  const first = outcome.stderr.split(/\r?\n/).find((line) => line.trim() !== "")?.trim() ?? "";
  const detail = first === "" ? "" : `: ${first.slice(0, 200)}`;
  const code = outcome.exitCode === null ? "did not finish" : `exited ${outcome.exitCode}`;
  return {
    id: "example-failed",
    severity: severityOf(options.failOnFailure === true),
    message: `${example.id} at ${file}:${example.pos.line} failed: it ${code}${limit}${detail}.`,
    pos: posOf(example, file),
    help: "Fix what the example does, or the limits and expected output it declares.",
  };
}

/** The finding for a hidden setup/teardown or runbook step that did not pass. */
export function runbookDiagnostic(
  options: { readonly failOnFailure?: boolean },
  example: MarkdownExample,
  file: string,
  step: RunbookStepResult,
): Diagnostic {
  const reason =
    step.status === "refused"
      ? "was refused: its command is not in the runbook's allowlist"
      : step.status === "precondition"
        ? `stopped before it ran: ${step.detail ?? "its precondition failed"}`
        : step.status === "mismatch"
          ? `printed unexpected output: expected ${quote(step.expected ?? "")} but got ${quote(step.actual ?? "")}`
          : "exited non-zero";
  return {
    id: "runbook-step",
    severity: severityOf(options.failOnFailure === true),
    message: `Runbook step ${example.id} at ${file}:${example.pos.line} ${reason}.`,
    pos: posOf(example, file),
    help: "Fix the step's command or expected output, or add the command to the runbook's allowlist.",
  };
}

/** Turns a type-check finding into a diagnostic; a type error is a warning unless the site fails on failure. */
export function typeDiagnosticOf(finding: ExampleTypeFinding, failOnFailure: boolean): Diagnostic {
  return {
    id: finding.id,
    severity: finding.id === "example-type-error" ? severityOf(failOnFailure) : "warning",
    message: finding.message,
    pos: finding.pos,
    ...(finding.help === undefined ? {} : { help: finding.help }),
  };
}

/** Turns any other type-check finding (a block that could not be checked) into an `info` diagnostic. */
export function exampleTypeDiagnostic(finding: ExampleTypeFinding): Diagnostic {
  return { id: finding.id, severity: "info", message: finding.message, pos: finding.pos, ...(finding.help === undefined ? {} : { help: finding.help }) };
}
