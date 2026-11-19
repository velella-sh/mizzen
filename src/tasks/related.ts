/**
 * Discover related tasks by semantic scope and input snapshot.
 *
 * Two tasks are duplicates when they share an input snapshot; they are dependent when their scopes
 * name the same reference, because a change to that page, block, collection, symbol, or file can
 * affect both. Every match carries the reasons it matched, in a fixed order, and matches are sorted
 * by task id. A task the principal cannot read is still reported by id and reason — enough to avoid
 * duplicate work — but its goal and scope are never copied into the result, and a shared-scope
 * reason does not name the reference.
 */
import type {
  TaskDocument,
  TaskRelatedMatch,
  TaskRelatedQuery,
  TaskRelatedReason,
} from "../contracts/task.ts";
import { canRead } from "./lifecycle.ts";
import { SCOPE_KINDS, type TaskScopeKind } from "./scope.ts";

/** The sentence a reason uses for each scope kind. */
const KIND_LABELS: Readonly<Record<TaskScopeKind, string>> = {
  pages: "page",
  blocks: "block",
  collections: "collection",
  symbols: "symbol",
  files: "file",
};

/** One reference both the query and a candidate name. */
interface SharedReference {
  readonly kind: TaskScopeKind;
  readonly ref: string;
}

/** Every reference the query scope and the candidate scope share, in scope order. */
function sharedReferences(query: TaskRelatedQuery, task: TaskDocument): readonly SharedReference[] {
  if (query.scope === undefined) return [];
  return SCOPE_KINDS.flatMap((kind) =>
    query.scope?.[kind]
      .filter((ref) => task.scope[kind].includes(ref))
      .map((ref) => ({ kind, ref })) ?? [],
  );
}

/** The reasons one task matches, or an empty list when it does not. */
function reasonsFor(
  query: TaskRelatedQuery,
  task: TaskDocument,
  readable: boolean,
): readonly TaskRelatedReason[] {
  const reasons: TaskRelatedReason[] = [];

  if (query.snapshot !== undefined && query.snapshot === task.snapshot.id) {
    reasons.push({ kind: "duplicate", detail: "Same input snapshot." });
  }

  const shared = sharedReferences(query, task);
  if (shared.length > 0) {
    if (readable) {
      for (const reference of shared) {
        reasons.push({
          kind: "dependent",
          detail: `Shares ${KIND_LABELS[reference.kind]} \`${reference.ref}\`.`,
        });
      }
    } else {
      reasons.push({ kind: "dependent", detail: "Shares scope with the query." });
    }
  }

  return reasons;
}

/** Finds duplicate and dependent tasks, sorted by id, without exposing unreadable content. */
export function relatedTasks(
  tasks: readonly TaskDocument[],
  query: TaskRelatedQuery,
  principal: string,
): readonly TaskRelatedMatch[] {
  if (query.snapshot === undefined && query.scope === undefined) return [];

  const matches: TaskRelatedMatch[] = [];
  for (const task of tasks) {
    const readable = canRead(task, principal);
    const reasons = reasonsFor(query, task, readable);
    if (reasons.length === 0) continue;

    matches.push({
      id: task.id,
      requestId: task.requestId,
      state: task.state,
      reasons,
      redacted: !readable,
      ...(readable ? { goal: task.goal, scope: task.scope } : {}),
    });
  }

  return matches.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
