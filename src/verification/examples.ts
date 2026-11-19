/**
 * Verify one code example and keep its source span (#1184).
 *
 * A broken sample produces a failed check with the source span of the fence, not a vague
 * message. The sample runs in the bounded Node runner: a fresh temporary folder, a scrubbed
 * environment, an output cap, the caller's timeout and memory limit, and network denied. A
 * passing sample records the same check id and the hash of the expected output, so correcting
 * the code and running the same check produces a receipt a reader can compare.
 *
 * The check stores hashes, not output: the proof stays portable and never carries a temporary
 * folder or a machine's path.
 */
import type { VerificationCheck, VerificationSpan } from "../contracts/verification.ts";
import { sha256 } from "../data/lock.ts";
import {
  DEFAULT_TIMEOUT_MS,
  runNodeExample,
  type ExampleLang,
} from "../pipeline/examples/run-node.ts";

/** One example to verify. */
export interface VerificationExample {
  /** Stable check id; the corrected run keeps the same id. */
  readonly id: string;
  /** The task the check belongs to. */
  readonly task: string;
  /** The input snapshot the task was planned against. */
  readonly snapshot: string;
  /** The commit the check runs at. */
  readonly commit: string;
  /** The source file, relative to the site root, with forward slashes. */
  readonly file: string;
  /** The fence's span in that file. */
  readonly span: VerificationSpan;
  readonly lang: ExampleLang;
  readonly code: string;
  /** The output the example should print. */
  readonly expected: string;
  readonly timeoutMs?: number;
  /** V8's old-space limit in MiB; `0` keeps V8's default. */
  readonly memoryMb?: number;
}

/** What one example check found. */
export interface ExampleVerification {
  readonly check: VerificationCheck;
  readonly passed: boolean;
  readonly expected: string;
  /** The actual output, for the caller's report; never written to the proof. */
  readonly actual: string;
}

/** One comparable text: LF line endings, no trailing whitespace, one final line feed removed. */
export function normalizeExampleOutput(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trimEnd();
}

/** Runs the example and returns the check, with its span when it fails. */
export async function verifyExample(example: VerificationExample): Promise<ExampleVerification> {
  const expected = normalizeExampleOutput(example.expected);
  const result = await runNodeExample({
    lang: example.lang,
    code: example.code,
    timeoutMs: example.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    memoryMb: example.memoryMb ?? 0,
    network: "deny",
  });
  const actual = normalizeExampleOutput(result.stdout);
  const passed = result.ok && actual === expected;
  const status: VerificationCheck["status"] = passed
    ? "passed"
    : result.timedOut
      ? "timed-out"
      : result.rejected
        ? "rejected"
        : "failed";
  const detail = passed
    ? undefined
    : result.timedOut
      ? `The example did not finish within ${example.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms.`
      : result.rejected
        ? "The example was refused before it ran."
        : actual === expected
          ? "The example exited non-zero."
          : "The example printed different output.";

  return {
    check: {
      id: example.id,
      criterion: example.id,
      task: example.task,
      snapshot: example.snapshot,
      commit: example.commit,
      status,
      command: ["node", `example.${example.lang}`],
      outputHash: sha256(result.stdout),
      expectedHash: sha256(expected),
      limits: {
        timeoutMs: example.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        memoryMb: example.memoryMb ?? 0,
        network: "deny",
        paths: "sandbox",
      },
      ...(passed ? {} : { span: { ...example.span, file: example.file } }),
      ...(detail === undefined ? {} : { detail }),
    },
    passed,
    expected,
    actual,
  };
}
