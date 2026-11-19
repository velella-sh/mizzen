/**
 * A task contract as a context request: the deterministic bridge between `src/tasks/` and `src/packs/`.
 *
 * The task's goal is the ranking sentence, every scope reference becomes an include hint, and a
 * page or file reference is also required evidence so trimming cannot drop it. An acceptance
 * criterion may name evidence in inline code; those references join the request too, attributed to
 * their criterion so answerability can point at the exact shortage. The change type is the task
 * kind a pack ranks with: an explicit option wins, otherwise the goal and criteria choose one by a
 * fixed keyword rule, never by a model. Permissions are not copied into the request; the compiler
 * checks `permissions.read` before it reads any content.
 */
import type { ContextRequest, TaskKind, VersionRange } from "../contracts/context-request.ts";
import type { TaskContract } from "../contracts/task.ts";
import { parseContextRequest } from "../packs/task.ts";

/** Options that shape the request a task becomes. */
export interface TaskRequestOptions {
  /** The ranking budget; defaults to the task's own `budget.contextTokens`. */
  readonly maxTokens?: number;
  /** Tokens held back for required evidence; must stay below the budget. */
  readonly reservedTokens?: number;
  /** A language constraint the site should apply. */
  readonly locale?: string;
  /** A documentation version range. */
  readonly version?: VersionRange;
  /** References to remove from the search; a scope reference here is a task contradiction. */
  readonly exclude?: readonly string[];
  /** The change type; without it the goals and criteria choose one deterministically. */
  readonly kind?: TaskKind;
}

/** The evidence one acceptance criterion asks for, in the request's own vocabulary. */
export interface CriterionEvidence {
  /** The criterion id. */
  readonly criterion: string;
  /** The page, file, block, collection, or symbol references the statement names. */
  readonly refs: readonly string[];
}

/** A task converted into a request, or the reasons its inputs make no valid request. */
export type TaskRequestResult =
  | {
      readonly request: ContextRequest;
      /** The change type the request ranks with. */
      readonly kind: TaskKind;
      /** One entry per acceptance criterion, including criteria that name no reference. */
      readonly evidence: readonly CriterionEvidence[];
    }
  | { readonly problems: readonly string[] };

/** The largest goal the request schema accepts. */
const GOAL_LIMIT = 2000;

/** The keyword profile each change type is inferred from, in matching order. */
const KIND_WORDS: readonly (readonly [TaskKind, readonly string[]])[] = [
  ["debug", ["bug", "debug", "fail", "error", "broken", "crash", "troubleshoot"]],
  ["migrate", ["migrate", "migration", "upgrade", "port", "rename", "version"]],
  ["review", ["review", "audit", "verify", "check"]],
  ["implement", ["add", "implement", "update", "change", "write", "create", "remove", "fix"]],
  ["explain", ["explain", "document", "understand", "how", "why", "what"]],
];

/** The distinct, non-empty entries of a list, in first-seen order. */
function unique(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const text = value.trim();
    if (text === "" || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

/** Every scope reference, in the scope's fixed kind order. */
function scopeRefs(task: TaskContract): readonly string[] {
  return unique([
    ...task.scope.pages,
    ...task.scope.blocks,
    ...task.scope.collections,
    ...task.scope.symbols,
    ...task.scope.files,
  ]);
}

/**
 * The references one acceptance statement names: inline code spans and task scope names that the
 * statement repeats. A check id is not a documentation reference, so it is deliberately left out.
 */
function namedRefs(statement: string, scope: readonly string[]): readonly string[] {
  const found: string[] = [];
  for (const match of statement.matchAll(/`([^`\n]+)`/g)) {
    const ref = (match[1] ?? "").trim();
    if (ref !== "") found.push(ref);
  }
  for (const ref of scope) {
    if (statement.includes(ref)) found.push(ref);
  }
  return unique(found);
}

/**
 * The change type: an explicit option, else the first kind whose words occur in the goal, else the
 * kind the criteria imply (all human reviews mean `review`), else `other`.
 */
export function changeTypeOf(task: TaskContract, explicit?: TaskKind): TaskKind {
  if (explicit !== undefined) return explicit;
  const words = new Set(task.goal.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  for (const [kind, keywords] of KIND_WORDS) {
    if (keywords.some((keyword) => words.has(keyword))) return kind;
  }
  return task.acceptance.length > 0 && task.acceptance.every((criterion) => criterion.review === true)
    ? "review"
    : "other";
}

/** A goal cut to the schema's limit without splitting a surrogate pair. */
function goalOf(task: TaskContract): string {
  const goal = task.goal.trim();
  return goal.length <= GOAL_LIMIT ? goal : goal.slice(0, GOAL_LIMIT);
}

/**
 * Converts a task into a validated {@link ContextRequest}.
 *
 * Scope references become include hints, page and file references become required evidence, and
 * every acceptance reference is required too, so a compiler cannot silently drop the evidence a
 * criterion names. Cross-field problems from the request parser are returned as one line each.
 */
export function requestForTask(task: TaskContract, options: TaskRequestOptions = {}): TaskRequestResult {
  const scope = scopeRefs(task);
  const evidence = task.acceptance.map((criterion) => ({
    criterion: criterion.id,
    refs: namedRefs(criterion.statement, scope),
  }));
  const acceptanceRefs = evidence.flatMap((entry) => entry.refs);
  const required = unique([
    ...task.scope.pages,
    ...task.scope.files,
    ...acceptanceRefs.filter((ref) => task.scope.pages.includes(ref) || task.scope.files.includes(ref)),
  ]);
  const include = unique([...scope, ...acceptanceRefs]);
  const exclude = unique(options.exclude ?? []);
  const kind = changeTypeOf(task, options.kind);
  const maxTokens = Math.max(1, Math.floor(options.maxTokens ?? task.budget.contextTokens));
  const reserved = options.reservedTokens === undefined ? undefined : Math.max(0, Math.floor(options.reservedTokens));

  const parsed = parseContextRequest({
    version: 1,
    task: { goal: goalOf(task), kind },
    include,
    exclude,
    ...(options.locale === undefined && options.version === undefined
      ? {}
      : {
          constraints: {
            ...(options.locale === undefined ? {} : { locale: options.locale }),
            ...(options.version === undefined ? {} : { version: options.version }),
          },
        }),
    budget: {
      maxTokens,
      ...(reserved === undefined ? {} : { reservedTokens: Math.min(reserved, maxTokens - 1) }),
    },
    requiredEvidence: {
      refs: required,
      source: true,
      versions: false,
      warnings: false,
      dependencies: true,
    },
  });

  if (parsed.request === undefined) {
    return {
      problems: parsed.problems.map(
        (problem) => `${problem.path === "" ? "/" : problem.path}: ${problem.code}: ${problem.message}`,
      ),
    };
  }
  return { request: parsed.request, kind, evidence };
}
