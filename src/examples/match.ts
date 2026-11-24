/**
 * Compares an example's expected stdout and stderr with what it produced (#1329).
 *
 * Two modes are supported and both are documented, so a reader never has to guess how whitespace is treated:
 *
 * - `exact` (the default): CRLF is folded to LF, trailing whitespace at the end of each line is removed, and trailing
 *   newlines at the end of the text are dropped. Nothing else changes: an internal blank line and leading indentation
 *   are significant.
 * - `pattern`: the expected text is a regular expression, tested against the produced text. The pattern still sees LF
 *   line endings and no trailing newlines, so a `^`/`$` anchors a real line, and the whole text is searched rather than
 *   matched, so a pattern names the one interesting line without repeating the rest.
 *
 * `matchOutput` returns whether the two agree and, when they do not, the first difference for the message. The rules are
 * the same for stdout and stderr, so one comparison serves both.
 */
import { firstDifference, type FirstDifference } from "../pipeline/examples/diagnostic.ts";

/** How an expected output is compared. */
export type OutputMatch = "exact" | "pattern";

/** The normalized text both modes compare: LF endings, no trailing spaces, no trailing newlines. */
export function normalizeOutput(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n+$/, "");
}

/** What comparing one expected output with the produced one found. */
export interface OutputResult {
  /** True when the two agree under the mode. */
  readonly ok: boolean;
  /** The expected text as it was compared (normalized, and for a pattern, the source). */
  readonly expected: string;
  /** The actual text as it was compared (normalized). */
  readonly actual: string;
  /** Present when the two differ: a bounded window of the first difference. */
  readonly difference?: FirstDifference;
  /** For a pattern that does not compile or does not match: why. */
  readonly problem?: "invalid-pattern" | "no-match";
}

/** Compiles a pattern, returning the error message when it is not a valid regular expression. */
export function compilePattern(pattern: string): { readonly regex: RegExp } | { readonly error: string } {
  try {
    return { regex: new RegExp(pattern, "m") };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Compares `expected` with `actual` under `mode`. `expected === null` means the fence checked only the exit code, so
 * there is nothing to compare and the result always succeeds; the caller decides whether absence is allowed.
 */
export function matchOutput(expected: string, actual: string, mode: OutputMatch): OutputResult {
  const normalizedExpected = normalizeOutput(expected);
  const normalizedActual = normalizeOutput(actual);

  if (mode === "pattern") {
    const compiled = compilePattern(normalizedExpected);
    if ("error" in compiled) {
      return { ok: false, expected: normalizedExpected, actual: normalizedActual, problem: "invalid-pattern" };
    }
    if (compiled.regex.test(normalizedActual)) {
      return { ok: true, expected: normalizedExpected, actual: normalizedActual };
    }
    return { ok: false, expected: normalizedExpected, actual: normalizedActual, problem: "no-match", difference: firstDifference(normalizedExpected, normalizedActual) };
  }

  if (normalizedExpected === normalizedActual) {
    return { ok: true, expected: normalizedExpected, actual: normalizedActual };
  }
  return {
    ok: false,
    expected: normalizedExpected,
    actual: normalizedActual,
    difference: firstDifference(normalizedExpected, normalizedActual),
  };
}

/** The documented whitespace rule, one sentence, for a diagnostic's help text. */
export const WHITESPACE_RULE =
  "Expected output is compared after CRLF is folded to LF, trailing spaces are removed from each line, and trailing newlines are dropped; in pattern mode the expected text is a regular expression.";
