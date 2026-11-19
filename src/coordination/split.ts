/**
 * Split one parent task into owned subtasks (#1193).
 *
 * Every subtask needs a unique key, an owner, a non-empty semantic scope, at least one acceptance
 * criterion, and a budget no larger than the parent's. Dependencies name sibling keys; they are
 * resolved to ids, sorted, and ordered, and a cycle or a self-dependency refuses the whole split.
 * Two subtasks may not carry the same scope: each part of the work has its own.
 *
 * The subtask id is the SHA-256 of the parent id and the key, so the same split gives the same ids
 * on every machine. The plan sorts subtasks by id and orders dependencies by id, so caller order
 * never reaches the output.
 */
import type { EditTransactionScope } from "../contracts/edit-transaction.ts";
import type {
  CoordinationParent,
  CoordinationPlan,
  CoordinationSplitResult,
  CoordinationSubtask,
} from "../contracts/coordination.ts";
import type {
  TaskAcceptanceCriterion,
  TaskBudget,
  TaskDocument,
  TaskPermissions,
  TaskProblem,
} from "../contracts/task.ts";
import { sha256 } from "../data/lock.ts";
import { byCodePoint, orderSubtasks } from "./graph.ts";

/** The scope kinds a subtask may own, in report order. */
const SCOPE_KINDS = ["pages", "blocks", "symbols", "records", "files"] as const;

/** One parsed subtask before its dependencies become ids. */
interface DraftSubtask {
  readonly id: string;
  readonly key: string;
  readonly owner: string;
  readonly goal: string;
  readonly scope: EditTransactionScope;
  readonly acceptance: readonly TaskAcceptanceCriterion[];
  readonly dependsOnKeys: readonly string[];
  readonly budget: TaskBudget;
}

/** The id of one subtask: content, never a counter. */
export function subtaskIdOf(parent: string, key: string): string {
  return sha256(`mizzen-coordination-subtask\0${parent}\0${key}`);
}

/** Splits a registered parent task into subtasks, or explains every malformed part. */
export function splitSubtasks(
  parent: TaskDocument,
  input: readonly unknown[],
): CoordinationSplitResult {
  const problems: TaskProblem[] = [];
  const parentPlan = coordinationParentOf(parent);

  if (!Array.isArray(input) || input.length === 0) {
    return {
      problems: [
        {
          path: "/subtasks",
          code: "coordination.subtasks-empty",
          message: "A split needs at least one subtask.",
        },
      ],
    };
  }

  const drafts: DraftSubtask[] = [];
  const keys = new Map<string, number>();
  input.forEach((value, index) => {
    const draft = draftOf(parent, value, index, problems);
    if (draft === undefined) return;
    const other = keys.get(draft.key);
    if (other !== undefined) {
      problems.push({
        path: `/subtasks/${index}/key`,
        code: "coordination.key-duplicate",
        message: `Subtask key \`${draft.key}\` is already used by \`/subtasks/${other}\`; give each subtask its own key.`,
      });
      return;
    }
    keys.set(draft.key, index);
    drafts.push(draft);
  });

  const byKey = new Map(drafts.map((draft) => [draft.key, draft] as const));
  const seenScopes = new Map<string, string>();
  for (const draft of drafts) {
    const key = scopeKey(draft.scope);
    const other = seenScopes.get(key);
    if (other !== undefined) {
      problems.push({
        path: `/subtasks/${draft.key}/scope`,
        code: "coordination.scope-duplicate",
        message: `Subtask \`${draft.key}\` has the same scope as \`${other}\`; each subtask needs its own scope.`,
      });
    } else {
      seenScopes.set(key, draft.key);
    }
  }

  const subtasks: CoordinationSubtask[] = drafts.map((draft) => ({
    id: draft.id,
    key: draft.key,
    parent: parentPlan.id,
    owner: draft.owner,
    goal: draft.goal,
    scope: draft.scope,
    acceptance: draft.acceptance,
    dependsOn: draft.dependsOnKeys.map((key) => {
      const dependency = byKey.get(key);
      if (dependency === undefined) {
        problems.push({
          path: `/subtasks/${draft.key}/dependsOn`,
          code: "coordination.dependency-unknown",
          message: `Subtask \`${draft.key}\` depends on \`${key}\`, which is not a sibling; add it or remove the dependency.`,
        });
        return "";
      }
      if (dependency.id === draft.id) {
        problems.push({
          path: `/subtasks/${draft.key}/dependsOn`,
          code: "coordination.dependency-self",
          message: `Subtask \`${draft.key}\` cannot depend on itself.`,
        });
      }
      return dependency.id;
    }).filter((id) => id !== "").sort(byCodePoint),
    budget: draft.budget,
    snapshot: parentPlan.snapshot,
    permissions: subtaskPermissions(parentPlan, draft.owner),
  }));

  const ordered = orderSubtasks(subtasks);
  problems.push(...ordered.problems);
  if (problems.length > 0) return { problems };

  return {
    plan: {
      version: 1,
      parent: parentPlan,
      subtasks: [...subtasks].sort((a, b) => byCodePoint(a.id, b.id)),
      order: ordered.order,
    },
    problems: [],
  };
}

/** The parent fields a split reads. */
export function coordinationParentOf(parent: TaskDocument): CoordinationParent {
  return {
    id: parent.id,
    goal: parent.goal,
    snapshot: parent.snapshot.id,
    budget: parent.budget,
    permissions: parent.permissions,
    acceptance: parent.acceptance,
  };
}

/** Parses one subtask, reporting every problem against its index. */
function draftOf(
  parent: TaskDocument,
  value: unknown,
  index: number,
  problems: TaskProblem[],
): DraftSubtask | undefined {
  const path = `/subtasks/${index}`;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    problems.push({
      path,
      code: "coordination.subtask-shape",
      message: "A subtask must be an object with `key`, `owner`, `goal`, `scope`, `acceptance`, and `budget`.",
    });
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const key = text(record.key, `${path}/key`, problems, "a unique key such as `install-guide`");
  const owner = text(record.owner, `${path}/owner`, problems, "the agent id that will own the subtask");
  const goal = text(record.goal, `${path}/goal`, problems, "one sentence");
  if (owner === "*") {
    problems.push({
      path: `${path}/owner`,
      code: "coordination.owner-wildcard",
      message: "A subtask owner must be one agent id, not `*`; every part needs one accountable owner.",
    });
  }
  const scope = scopeOf(record.scope, `${path}/scope`, problems);
  const acceptance = acceptanceOf(record.acceptance, `${path}/acceptance`, problems);
  const budget = budgetOf(record.budget, `${path}/budget`, parent.budget, problems);
  const dependsOnKeys = dependenciesOf(record.dependsOn, `${path}/dependsOn`, problems);

  if (
    key === undefined ||
    owner === undefined ||
    goal === undefined ||
    scope === undefined ||
    acceptance === undefined ||
    budget === undefined ||
    dependsOnKeys === undefined
  ) {
    return undefined;
  }
  return { id: subtaskIdOf(parent.id, key), key, owner: owner === "*" ? "" : owner, goal, scope, acceptance, dependsOnKeys, budget };
}

/** A trimmed non-empty string, or a problem and `undefined`. */
function text(
  value: unknown,
  path: string,
  problems: TaskProblem[],
  expected: string,
): string | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    problems.push({
      path,
      code: "coordination.text",
      message: `\`${path}\` must be ${expected}.`,
    });
    return undefined;
  }
  return value.trim();
}

/** All five scope lists, trimmed, non-empty overall, with no duplicates. */
function scopeOf(
  value: unknown,
  path: string,
  problems: TaskProblem[],
): EditTransactionScope | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    problems.push({
      path,
      code: "coordination.scope-shape",
      message: `\`${path}\` must name at least one page, block, symbol, record, or file.`,
    });
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const before = problems.length;
  const lists = SCOPE_KINDS.map((kind) => stringsOf(record[kind] ?? [], `${path}/${kind}`, problems));
  const scope: EditTransactionScope = {
    pages: lists[0]!,
    blocks: lists[1]!,
    symbols: lists[2]!,
    records: lists[3]!,
    files: lists[4]!,
  };
  if (SCOPE_KINDS.every((kind) => scope[kind].length === 0) && problems.length === before) {
    problems.push({
      path,
      code: "coordination.scope-empty",
      message: `\`${path}\` must name at least one page, block, symbol, record, or file.`,
    });
  }
  return problems.length === before ? scope : undefined;
}

/** A list of trimmed strings with no repeats. */
function stringsOf(value: unknown, path: string, problems: TaskProblem[]): readonly string[] {
  if (!Array.isArray(value)) {
    problems.push({
      path,
      code: "coordination.list",
      message: `\`${path}\` must be an array of strings.`,
    });
    return [];
  }
  const seen = new Set<string>();
  const list: string[] = [];
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      problems.push({
        path: `${path}/${index}`,
        code: "coordination.list-entry",
        message: `\`${path}/${index}\` must be a non-empty string.`,
      });
      return;
    }
    const trimmed = entry.trim();
    if (seen.has(trimmed)) {
      problems.push({
        path: `${path}/${index}`,
        code: "coordination.duplicate",
        message: `\`${path}/${index}\` repeats \`${trimmed}\`; remove the duplicate.`,
      });
      return;
    }
    seen.add(trimmed);
    list.push(trimmed);
  });
  return list;
}

/** Acceptance criteria with unique ids and exactly one proof mode each. */
function acceptanceOf(
  value: unknown,
  path: string,
  problems: TaskProblem[],
): readonly TaskAcceptanceCriterion[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    problems.push({
      path,
      code: "coordination.acceptance-empty",
      message: `\`${path}\` needs at least one criterion with a \`check\` or \`review: true\`.`,
    });
    return undefined;
  }
  const before = problems.length;
  const seen = new Set<string>();
  const criteria: TaskAcceptanceCriterion[] = value.map((entry, index) => {
    const at = `${path}/${index}`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      problems.push({
        path: at,
        code: "coordination.acceptance-shape",
        message: `\`${at}\` must be an object with \`id\`, \`statement\`, and exactly one of \`check\` or \`review: true\`.`,
      });
      return { id: "", statement: "" };
    }
    const record = entry as Record<string, unknown>;
    const id = text(record.id, `${at}/id`, problems, "a unique criterion id") ?? "";
    const statement = text(record.statement, `${at}/statement`, problems, "what must be true") ?? "";
    if (seen.has(id)) {
      problems.push({
        path: `${at}/id`,
        code: "coordination.acceptance-duplicate",
        message: `Criterion id \`${id}\` is repeated; give each criterion its own id.`,
      });
    }
    seen.add(id);
    const check = record.check === undefined ? undefined : text(record.check, `${at}/check`, problems, "the id of a check");
    const review = record.review === true;
    if (record.check !== undefined && record.review !== undefined) {
      problems.push({
        path: at,
        code: "coordination.acceptance-mode",
        message: `\`${at}\` names both \`check\` and \`review\`; keep exactly one.`,
      });
    } else if (record.check === undefined && !review) {
      problems.push({
        path: at,
        code: "coordination.acceptance-mode",
        message: `\`${at}\` needs \`check\` (a check id) or \`review: true\` (human review).`,
      });
    }
    return {
      id,
      statement,
      ...(check === undefined ? {} : { check }),
      ...(review ? { review: true as const } : {}),
    };
  });
  return problems.length === before ? criteria : undefined;
}

/** Three non-negative whole limits, none larger than the parent's. */
function budgetOf(
  value: unknown,
  path: string,
  parent: TaskBudget,
  problems: TaskProblem[],
): TaskBudget | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    problems.push({
      path,
      code: "coordination.budget-shape",
      message: `\`${path}\` needs \`contextTokens\`, \`toolCalls\`, and \`timeMs\`.`,
    });
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const before = problems.length;
  const limit = (key: keyof TaskBudget): number => {
    const raw = record[key];
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
      problems.push({
        path: `${path}/${key}`,
        code: "coordination.budget",
        message: `\`${path}/${key}\` must be a non-negative whole number.`,
      });
      return 0;
    }
    if (raw > parent[key]) {
      problems.push({
        path: `${path}/${key}`,
        code: "coordination.budget-parent",
        message: `\`${path}/${key}\` is ${raw}, more than the parent's ${parent[key]}; a subtask cannot exceed its parent.`,
      });
    }
    return raw;
  };
  const budget: TaskBudget = {
    contextTokens: limit("contextTokens"),
    toolCalls: limit("toolCalls"),
    timeMs: limit("timeMs"),
  };
  return problems.length === before ? budget : undefined;
}

/** Dependency keys, trimmed and unique; the graph resolves them to ids. */
function dependenciesOf(
  value: unknown,
  path: string,
  problems: TaskProblem[],
): readonly string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    problems.push({
      path,
      code: "coordination.depends-shape",
      message: `\`${path}\` must be an array of sibling keys.`,
    });
    return undefined;
  }
  const before = problems.length;
  const list = stringsOf(value, path, problems);
  return problems.length === before ? [...list].sort(byCodePoint) : undefined;
}

/** Read comes from the parent; write and check belong to the one owner. */
function subtaskPermissions(parent: CoordinationParent, owner: string): TaskPermissions {
  return {
    read: parent.permissions.read,
    write: [owner],
    check: [owner],
  };
}

/** A canonical form of a scope, used only to detect two identical subtasks. */
function scopeKey(scope: EditTransactionScope): string {
  return SCOPE_KINDS.map((kind) => `${kind}:${[...scope[kind]].sort(byCodePoint).join(",")}`).join("|");
}
