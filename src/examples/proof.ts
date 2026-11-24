/**
 * Turns a page's recorded example results into verification checks (#1336), so a proof can carry example status
 * beside every other bounded check.
 *
 * A proof never stores output: it stores a hash. So each passing or failing example becomes a check whose `outputHash`
 * is the hash of the outputs it compared, and whose `status` follows the recorded run. The check keeps the fence's
 * span when it failed, and the environment hash in its `detail`, so an independent verifier can match the run to the
 * lock it was recorded under. Nothing here reads a temporary path or a clock.
 */
import { createHash } from "node:crypto";
import type { FenceExampleResult } from "../contracts/code.ts";
import type { VerificationCheck, VerificationCheckStatus, VerificationLimits } from "../contracts/verification.ts";

/** The inputs one page's example checks are tied to. */
export interface ExampleProofInput {
  /** The task the checks prove. */
  readonly task: string;
  /** The input snapshot the task was planned against. */
  readonly snapshot: string;
  /** The commit the examples were recorded at. */
  readonly commit: string;
  /** The limits the run used; recorded on every check. */
  readonly limits: VerificationLimits;
  /** The page's recorded results, keyed by fence id. */
  readonly results: Readonly<Record<string, FenceExampleResult>>;
}

/** SHA-256 of a text, as the proof writes hashes. */
function hashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The check status a recorded result maps to. */
function statusOf(result: FenceExampleResult): VerificationCheckStatus {
  if (result.status === "passed") return "passed";
  if (result.status === "failed") return "failed";
  // A stale result is evidence from another version of the fence, so it cannot prove this one.
  if (result.status === "stale") return "unrun";
  return "unrun";
}

/** The output hash of a result: the concatenated normalized outputs it compared, so a hit and a run agree. */
function outputHashOf(result: FenceExampleResult): string {
  const outputs = result.evidence?.outputs ?? [];
  return hashOf(JSON.stringify(outputs.map((output) => [output.stream, output.expected ?? null, output.actual, output.ok])));
}

/**
 * One check per recorded example, sorted by check id. A `skipped` or `sandbox-unavailable` result is `unrun`, because
 * it did not run and cannot prove anything; the reason is kept in `detail`, never rewritten as a pass.
 */
export function exampleChecks(input: ExampleProofInput): readonly VerificationCheck[] {
  const ids = Object.keys(input.results).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return ids.map((id) => {
    const result = input.results[id]!;
    const status = statusOf(result);
    const reason =
      result.status === "sandbox-unavailable"
        ? `The example was not run: the host has no OS sandbox.`
        : result.status === "skipped"
          ? `The example was not run: its language has no runner, or a session before it failed.`
          : result.status === "stale"
            ? `The recorded result is from an earlier version of the fence.`
            : undefined;
    const detail = [result.evidence?.violation === undefined ? undefined : `violation: ${result.evidence.violation}`, result.environment === undefined ? undefined : `environment: ${result.environment}`, reason]
      .filter((part): part is string => part !== undefined)
      .join("; ");
    return {
      id: `example:${id}`,
      criterion: id,
      task: input.task,
      snapshot: input.snapshot,
      commit: input.commit,
      status,
      command: ["example", result.language],
      outputHash: outputHashOf(result),
      limits: input.limits,
      ...(status === "passed" ? {} : { span: { file: result.file, line: result.line, column: 1, endLine: result.line, endColumn: 1 } }),
      ...(detail === "" ? {} : { detail }),
    };
  });
}
