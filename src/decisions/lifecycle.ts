/**
 * The decision lifecycle: five statuses, one relationship (`supersedes`), and the version or snapshot a decision
 * applies to.
 *
 * Supersession is answered from the records themselves, never from a hand-written back-reference: a record's
 * `supersededBy` is every record that names it in `supersedes`. A supersession cycle is refused with one error per
 * cycle, and a cycle's members are never presented as the decision in effect.
 *
 * A historical question resolves the decision in effect at a version or snapshot, not simply the newest record. A
 * superseded record is still the answer for a version that its replacement does not cover, which is what makes the
 * history correct; at the current version the replacement is the answer.
 */
import type { DecisionProblem, DecisionRecord, DecisionQuery, DecisionStatus } from "../contracts/decisions.ts";
import { formatSpan } from "../source/spans.ts";

/** The statuses that can be the decision in effect, in the order they win a tie. */
const IN_EFFECT: readonly DecisionStatus[] = ["accepted", "proposed", "superseded"];

/** Compares two version folders, `v1`, `v1.2`, and `v1.2.3`, by their numeric segments. */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string): number[] => {
    const match = /^v?(\d+(?:\.\d+)*)$/i.exec(value.trim());
    if (match === null) return [Number.NaN];
    return match[1]!.split(".").map((part) => Number(part));
  };
  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const l = left[index] ?? 0;
    const r = right[index] ?? 0;
    if (Number.isNaN(l) || Number.isNaN(r)) {
      const byPoint = a < b ? -1 : a > b ? 1 : 0;
      return byPoint;
    }
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

/** Compares strings by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Whether a record's validity permits the question. A record with no validity applies to every question. A record's
 * version or snapshot limit excludes it only when the question asks about that dimension and the limit does not cover
 * it: a question that names no version is about the current state, and a version-bounded record is still a candidate
 * there, resolved by date against the others.
 */
export function appliesAt(record: DecisionRecord, query: DecisionQuery): boolean {
  const validity = record.validity;
  if (query.version !== undefined) {
    const version = query.version;
    if (validity.versions !== undefined && !validity.versions.some((candidate) => compareVersions(candidate, version) === 0)) {
      return false;
    }
    if (validity.from !== undefined && compareVersions(version, validity.from) < 0) return false;
    if (validity.until !== undefined && compareVersions(version, validity.until) > 0) return false;
    return true;
  }
  if (query.snapshot !== undefined && validity.snapshots !== undefined) {
    return validity.snapshots.includes(query.snapshot);
  }
  return true;
}

/** The edges of the supersession graph: each record id to the ids it supersedes. */
function supersessionEdges(records: readonly DecisionRecord[]): Map<string, readonly string[]> {
  const edges = new Map<string, readonly string[]>();
  for (const record of records) edges.set(record.id, record.supersedes.filter((id) => id !== record.id));
  return edges;
}

/** Every cycle in the supersession graph, each as the ids from the repeated node back to itself, sorted. */
function cyclesOf(edges: ReadonlyMap<string, readonly string[]>): readonly (readonly string[])[] {
  const colour = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const found: string[][] = [];
  const seen = new Set<string>();

  const visit = (id: string): void => {
    colour.set(id, 1);
    stack.push(id);
    for (const next of edges.get(id) ?? []) {
      if (!edges.has(next)) continue;
      if (colour.get(next) === 1) {
        const start = stack.indexOf(next);
        if (start !== -1) {
          const cycle = [...stack.slice(start), next];
          const key = [...cycle].sort(byCodePoint).join("\u0000");
          if (!seen.has(key)) {
            seen.add(key);
            found.push(cycle);
          }
        }
      } else if ((colour.get(next) ?? 0) === 0) {
        visit(next);
      }
    }
    stack.pop();
    colour.set(id, 2);
  };

  for (const id of [...edges.keys()].sort(byCodePoint)) {
    if ((colour.get(id) ?? 0) === 0) visit(id);
  }
  return found;
}

/** Every id that appears in a cycle, so it is never presented as the decision in effect. */
function cycleMembers(cycles: readonly (readonly string[])[]): ReadonlySet<string> {
  const members = new Set<string>();
  for (const cycle of cycles) for (const id of cycle) members.add(id);
  return members;
}

/** The result of applying the lifecycle to a site's records. */
export interface LifecycleResult {
  /** The records with `supersededBy` filled from other records, sorted by id. */
  readonly records: readonly DecisionRecord[];
  /** Lifecycle problems, sorted by id and then message. */
  readonly problems: readonly DecisionProblem[];
  /** The ids in a supersession cycle, which are never the decision in effect. */
  readonly cycles: readonly (readonly string[])[];
}

/**
 * Fills `supersededBy` from every record's `supersedes`, refuses a supersession cycle, and reports a `supersedes`
 * that names no record in the site, a `from` after its `until`, and a record that names itself.
 */
export function applyLifecycle(records: readonly DecisionRecord[]): LifecycleResult {
  const sorted = [...records].sort((a, b) => byCodePoint(a.id, b.id));
  const known = new Set(sorted.map((record) => record.id));
  const problems: DecisionProblem[] = [];

  const supersededBy = new Map<string, Set<string>>();
  for (const record of sorted) supersededBy.set(record.id, new Set());
  for (const record of sorted) {
    if (record.supersedes.includes(record.id)) {
      problems.push({
        id: "decision.self-supersession",
        severity: "error",
        message: `Decision "${record.id}" names itself in \`supersedes\`.`,
        ...spanProp(record),
      });
    }
    for (const target of record.supersedes) {
      if (target === record.id) continue;
      if (!known.has(target)) {
        problems.push({
          id: "decision.supersession-unknown",
          severity: "warning",
          message: `Decision "${record.id}" supersedes "${target}", which is not a decision in this site.`,
          ...spanProp(record),
        });
        continue;
      }
      supersededBy.get(target)!.add(record.id);
    }
    if (record.validity.from !== undefined && record.validity.until !== undefined && compareVersions(record.validity.from, record.validity.until) > 0) {
      problems.push({
        id: "decision.validity-range",
        severity: "error",
        message: `Decision "${record.id}" is valid from ${record.validity.from} until ${record.validity.until}, which is earlier.`,
        ...spanProp(record),
      });
    }
  }

  const edges = supersessionEdges(sorted);
  const cycles = cyclesOf(edges);
  for (const cycle of cycles) {
    problems.push({
      id: "decision.supersession-cycle",
      severity: "error",
      message: `A supersession cycle: ${cycle.join(" -> ")}. A decision cannot replace itself through a chain.`,
    });
  }

  const filled = sorted.map((record): DecisionRecord => ({
    ...record,
    supersededBy: [...(supersededBy.get(record.id) ?? [])].sort(byCodePoint),
  }));

  return {
    records: filled,
    problems: sortProblems(problems),
    cycles,
  };
}

/** A record's span, when it has one, as the `span` property of a problem. */
function spanProp(record: DecisionRecord): { readonly span?: string } {
  return record.span === undefined ? {} : { span: formatSpan(record.span) };
}

/** Sorts problems by code, then message. */
function sortProblems(problems: readonly DecisionProblem[]): DecisionProblem[] {
  return [...problems].sort((a, b) => byCodePoint(a.id, b.id) || byCodePoint(a.message, b.message));
}

/** The result of resolving a question against the lifecycle. */
export interface Resolution {
  /** The decision in effect at the question, or `undefined` when none applies. */
  readonly current?: DecisionRecord;
  /** The decisions that came before: everything the current one supersedes, transitively, newest first. */
  readonly history: readonly DecisionRecord[];
}

/**
 * Resolves the question: the decision in effect, and the decisions it superseded.
 *
 * The candidates are the records the question is about (the caller passes only those). A record is overridden when an
 * applicable candidate supersedes it; what remains is the decision in effect, and the newest of those wins. A record
 * whose validity excludes the question never overrides another, so a decision replaced only for a later version stays
 * in effect for the earlier one. The history is the supersession closure of the current decision, newest first: it
 * names what the current one replaced, whether or not that record is valid at the same version.
 */
export function inEffectAt(
  records: readonly DecisionRecord[],
  query: DecisionQuery,
  cycles: ReadonlySet<string> = new Set(),
): Resolution {
  const byId = new Map(records.map((record) => [record.id, record]));
  const applicable = records.filter((record) => appliesAt(record, query) && !cycles.has(record.id));
  if (applicable.length === 0) return { history: [] };

  const applicableIds = new Set(applicable.map((record) => record.id));
  const overridden = new Set<string>();
  for (const record of applicable) {
    for (const target of record.supersedes) if (applicableIds.has(target)) overridden.add(target);
  }

  const live = applicable.filter((record) => !overridden.has(record.id));
  const ranked = [...live].sort((a, b) => {
    const aRank = IN_EFFECT.indexOf(a.status);
    const bRank = IN_EFFECT.indexOf(b.status);
    const aScore = aRank === -1 ? Number.MAX_SAFE_INTEGER : aRank;
    const bScore = bRank === -1 ? Number.MAX_SAFE_INTEGER : bRank;
    if (aScore !== bScore) return aScore - bScore;
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return byCodePoint(a.id, b.id);
  });

  const current = ranked.find((record) => IN_EFFECT.includes(record.status));
  if (current === undefined) return { history: [] };

  // The history is everything the current decision supersedes, transitively, that the caller's candidate set holds.
  const seen = new Set<string>([current.id]);
  const queue = [...current.supersedes];
  const history: DecisionRecord[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const record = byId.get(id);
    if (record === undefined) continue;
    history.push(record);
    queue.push(...record.supersedes);
  }
  history.sort((a, b) => (a.date === b.date ? byCodePoint(a.id, b.id) : a.date < b.date ? 1 : -1));
  return { current, history };
}

/** Every id that is a member of a cycle, in the shape {@link inEffectAt} takes. */
export function cycleIdSet(result: LifecycleResult): ReadonlySet<string> {
  return cycleMembers(result.cycles);
}
