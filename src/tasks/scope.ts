/**
 * Semantic task scope: pages, block ids, collections, symbols, and files.
 *
 * The parser always produces all five lists. {@link validateScopeReferences} checks them against a
 * caller-supplied index before execution, so a task that names a page, block, collection, symbol,
 * or file the site does not have is refused with the exact list and position, not discovered after
 * the first write. A kind the index does not name is not checked, which lets a caller validate the
 * kinds it can resolve without pretending the others were verified.
 */
import type { TaskProblem, TaskScope } from "../contracts/task.ts";

/** The five scope kinds, in the order a report lists them. */
export const SCOPE_KINDS = ["pages", "blocks", "collections", "symbols", "files"] as const;

/** One kind of semantic reference. */
export type TaskScopeKind = (typeof SCOPE_KINDS)[number];

/** The known references for each kind. An absent kind is not checked. */
export interface TaskReferenceIndex {
  readonly pages?: ReadonlySet<string>;
  readonly blocks?: ReadonlySet<string>;
  readonly collections?: ReadonlySet<string>;
  readonly symbols?: ReadonlySet<string>;
  readonly files?: ReadonlySet<string>;
}

/** The label a problem uses for each kind. */
const LABELS: Readonly<Record<TaskScopeKind, string>> = {
  pages: "Page",
  blocks: "Block",
  collections: "Collection",
  symbols: "Symbol",
  files: "File",
};

/** The empty scope: every list present and empty. */
export function emptyScope(): TaskScope {
  return { pages: [], blocks: [], collections: [], symbols: [], files: [] };
}

/** True when no list names a reference. */
export function scopeIsEmpty(scope: TaskScope): boolean {
  return SCOPE_KINDS.every((kind) => scope[kind].length === 0);
}

/** Every reference in scope order, for display and comparison. */
export function scopeReferences(scope: TaskScope): readonly { readonly kind: TaskScopeKind; readonly ref: string }[] {
  return SCOPE_KINDS.flatMap((kind) => scope[kind].map((ref) => ({ kind, ref })));
}

/**
 * Reports every reference that the index says does not exist, in scope order. A kind the index
 * leaves out is accepted as-is; the caller can validate each kind once it can resolve that kind.
 */
export function validateScopeReferences(
  scope: TaskScope,
  index: TaskReferenceIndex,
): readonly TaskProblem[] {
  const problems: TaskProblem[] = [];
  for (const kind of SCOPE_KINDS) {
    const known = index[kind];
    if (known === undefined) continue;
    for (const [position, ref] of scope[kind].entries()) {
      if (known.has(ref)) continue;
      problems.push({
        path: `/scope/${kind}/${position}`,
        code: "task.scope-unknown",
        message: `${LABELS[kind]} \`${ref}\` does not exist in the site; remove it from \`scope.${kind}\` or add the missing reference.`,
      });
    }
  }
  return problems;
}
