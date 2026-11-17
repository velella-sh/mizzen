import type { Diagnostic } from "../contracts/diagnostic.ts";
import type { MarkdownExample } from "../markdown/plugins/example-fence.ts";

/**
 * Associates a page's examples with the CI checks that prove them.
 *
 * An example is a fence marked `test`; it gets a page-local id such as `example-3`. A command check names one of
 * those ids and the repository test that runs its command:
 *
 * ```ts
 * commandChecks(examples, [{ id: "example-3", test: "test/guide/install.test.ts" }]);
 * ```
 *
 * Only declared blocks are returned, so an example that is not listed is never run by this mapping; a fence that is
 * not an example has no id and cannot be declared. A duplicated id and an id that names no example are errors, and
 * neither produces a check: a consumer must fix the declaration before anything runs. The findings have no position,
 * because a declaration is not source Markdown; the mapped block carries its own `pos`.
 */

/** One explicit CI check: an example id on a page and the repository test that covers its command. */
export interface CommandCheck {
  /** The example's page-local id, such as `example-3`. */
  readonly id: string;
  /** The repository test that proves the command, relative to the repository root. */
  readonly test: string;
}

/** One declared check resolved to the block it names. */
export interface CheckedCommand {
  /** The repository test from the declaration. */
  readonly test: string;
  /** The example the check names, with its source span. */
  readonly example: MarkdownExample;
}

/** The mapping's result: the resolvable checks, in declaration order, and one finding per bad declaration. */
export interface CommandChecks {
  readonly checks: readonly CheckedCommand[];
  readonly diagnostics: readonly Diagnostic[];
}

/** Stable id of the finding for a block declared more than once. */
export const COMMAND_CHECK_DUPLICATE_ID = "command-check-duplicate";

/** Stable id of the finding for a declaration that names no example. */
export const COMMAND_CHECK_UNKNOWN_ID = "command-check-unknown";

/**
 * Resolves `declared` against `examples`, keeping only checks whose id names exactly one example.
 *
 * Checks keep declaration order. An id declared twice is one duplicate finding, and an id with no example is one
 * unknown finding. Both are errors: the caller must correct the mapping, never guess which block was meant.
 */
export function commandChecks(
  examples: readonly MarkdownExample[],
  declared: readonly CommandCheck[],
): CommandChecks {
  const examplesById = new Map(examples.map((example) => [example.id, example]));
  const counts = new Map<string, number>();
  for (const check of declared) counts.set(check.id, (counts.get(check.id) ?? 0) + 1);

  const checks: CheckedCommand[] = [];
  const diagnostics: Diagnostic[] = [];
  const reported = new Set<string>();

  for (const check of declared) {
    if ((counts.get(check.id) ?? 0) > 1) {
      if (!reported.has(check.id)) {
        reported.add(check.id);
        diagnostics.push({
          id: COMMAND_CHECK_DUPLICATE_ID,
          severity: "error",
          message: `Block "${check.id}" has more than one command check.`,
          help: "Give each block exactly one test, or remove the extra declaration.",
        });
      }
      continue;
    }

    const example = examplesById.get(check.id);
    if (example === undefined) {
      diagnostics.push({
        id: COMMAND_CHECK_UNKNOWN_ID,
        severity: "error",
        message: `Command check names block "${check.id}", which is not an example on this page.`,
        help: 'Use the id of a fence marked "test" on this page.',
      });
      continue;
    }

    checks.push({ test: check.test, example });
  }

  return { checks, diagnostics };
}
