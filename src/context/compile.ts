/**
 * Task-aware context compilation: a task contract becomes a request, the graph selects entry
 * points and closes their dependencies, the sources become exact fragments, and a fixed budget
 * decides what fits. The result explains every omission, answers every acceptance criterion, and
 * turns each gap into a precise scope, approval, or evidence request.
 *
 * The compiler reads the site model and an optional graph; it never reads a clock, network, or
 * environment. An unchanged task on an unchanged build gives byte-identical Markdown and JSON.
 * Private record fields never reach a fragment, an omission, metadata, or lineage: the 0.2.5
 * `public` allowlist is applied before the text is built, and a caller without `permissions.read`
 * gets no content at all.
 */
import type { ContextRequest } from "../contracts/context-request.ts";
import type { Site } from "../contracts/content.ts";
import type { BlocksLock } from "../blocks/lock.ts";
import type { Diagnostic, Graph, TaskContract } from "../contracts/index.ts";
import { emptyBlocksLock } from "../blocks/lock.ts";
import { canonicalJson, sha256 } from "../data/lock.ts";
import { hashOf } from "../outputs/build-hash.ts";
import { buildIdentityOf } from "../packs/compile.ts";
import { estimatePack } from "../packs/tokens.ts";
import { contextGraphOf, selectFromGraph, type ContextSelection } from "./select.ts";
import { fragmentsOf, taskReferences } from "./sources.ts";
import { packContext } from "./budget.ts";
import { requestForTask, type CriterionEvidence } from "./request.ts";
import { contextDecisionsOf, type ContextDecisions } from "../decisions/context.ts";
import type {
  CompiledContext,
  ContextAccounting,
  ContextAnswerability,
  ContextCache,
  ContextCriterionAnswer,
  ContextEntryKind,
  ContextFragment,
  ContextOmission,
  ContextOmissionReason,
  ContextRequestAction,
} from "./types.ts";

/** Options of {@link compileTaskContext}. */
export interface CompileContextOptions {
  /** A graph to read; without it the site's structural graph, or a collected one when `root` is set. */
  readonly graph?: Graph;
  /** The site root, so links, includes, code references, and symbols can be collected. */
  readonly root?: string;
  /** The block lock, so a removed or moved block is answered from the build's mapping. */
  readonly lock?: BlocksLock;
  /** The ranking budget; defaults to the task's `budget.contextTokens`. */
  readonly maxTokens?: number;
  /** Longest dependency path; default 3. */
  readonly maxDepth?: number;
  /** Most selected nodes; default 48. */
  readonly maxNodes?: number;
  /** The change type; without it the goal and criteria choose one deterministically. */
  readonly kind?: import("../contracts/context-request.ts").TaskKind;
  /** A language constraint. */
  readonly locale?: string;
  /** References to keep out of the search. */
  readonly exclude?: readonly string[];
  /** The principal asking for the pack; checked against `task.permissions.read`. */
  readonly principal?: string;
  /** Audiences the graph may expose; without it, public nodes only. */
  readonly allow?: readonly string[];
  /** Diagnostics the compiler produced, such as a rejected cycle or an unresolved reference. */
  readonly report?: (diagnostic: Diagnostic) => void;
}

/** Raised when the task cannot become a valid request. */
export class ContextCompileError extends Error {
  /** One line per request problem, in the request parser's order. */
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`the task makes no valid context request: ${problems.join(" ")}`);
    this.name = "ContextCompileError";
    this.problems = problems;
  }
}

/** The task's scope references, in kind order. */
function scopeRefs(task: TaskContract): readonly string[] {
  return [
    ...task.scope.pages,
    ...task.scope.blocks,
    ...task.scope.collections,
    ...task.scope.symbols,
    ...task.scope.files,
  ];
}

/** Whether the principal may read the task; a caller that names none is the task's owner. */
function readable(task: TaskContract, principal: string | undefined): boolean {
  if (principal === undefined) return true;
  return task.permissions.read.includes("*") || task.permissions.read.includes(principal);
}

/** The references every fragment answers, for coverage checks. */
function coveredRefs(fragments: readonly ContextFragment[]): ReadonlySet<string> {
  const covered = new Set<string>();
  for (const fragment of fragments) {
    covered.add(fragment.id);
    for (const ref of fragment.refs) covered.add(ref);
  }
  return covered;
}

/** The evidence a criterion needs: its named refs, its check node, or the whole scope. */
function evidenceRefs(criterion: TaskContract["acceptance"][number], evidence: readonly CriterionEvidence[], scope: readonly string[]): readonly string[] {
  const named = evidence.find((entry) => entry.criterion === criterion.id)?.refs ?? [];
  const refs = named.length > 0 ? named : scope;
  return criterion.check === undefined ? [...refs] : [...refs, `check:${criterion.check}`];
}

/** One criterion's answer, with the exact references no fragment covers. */
function criterionAnswer(
  criterion: TaskContract["acceptance"][number],
  evidence: readonly CriterionEvidence[],
  scope: readonly string[],
  covered: ReadonlySet<string>,
  fragments: readonly ContextFragment[],
): ContextCriterionAnswer {
  const refs = evidenceRefs(criterion, evidence, scope);
  const shortage = refs.filter((ref) => !covered.has(ref));
  return {
    id: criterion.id,
    statement: criterion.statement,
    satisfied: refs.length === 0 ? fragments.length > 0 : shortage.length === 0,
    evidence: refs,
    shortage,
  };
}

/** Whether the pack answers every criterion, and the union of the missing references. */
function answerabilityOf(
  task: TaskContract,
  evidence: readonly CriterionEvidence[],
  fragments: readonly ContextFragment[],
): ContextAnswerability {
  const scope = scopeRefs(task);
  const covered = coveredRefs(fragments);
  const criteria = task.acceptance.map((criterion) => criterionAnswer(criterion, evidence, scope, covered, fragments));
  const shortages = [...new Set(criteria.flatMap((criterion) => criterion.shortage))];
  return { complete: criteria.every((criterion) => criterion.satisfied), criteria, shortages };
}

/** The block, record, page, and other inputs the pack read, for cache invalidation. */
function dependenciesOf(task: TaskContract, fragments: readonly ContextFragment[]): readonly string[] {
  const dependencies = new Set<string>();
  for (const fragment of fragments) {
    if (fragment.source.file !== "") dependencies.add(`file:${fragment.source.file}`);
    if (fragment.source.block !== undefined) dependencies.add(`block:${fragment.source.block}`);
    if (fragment.source.record !== undefined) dependencies.add(`record:${fragment.source.record}`);
  }
  for (const block of task.scope.blocks) dependencies.add(`block:${block}`);
  for (const collection of task.scope.collections) dependencies.add(`collection:${collection}`);
  for (const symbol of task.scope.symbols) dependencies.add(`symbol:${symbol}`);
  return [...dependencies].sort();
}

/** The deterministic cache identity: the request, both snapshots, the budget, and the fragment bytes. */
function cacheOf(request: ContextRequest, task: TaskContract, build: string, fragments: readonly ContextFragment[]): ContextCache {
  const key = sha256(
    canonicalJson({
      version: 1,
      request,
      taskSnapshot: task.snapshot.id,
      build,
      fragments: fragments.map((fragment) => `${fragment.id}\u0000${hashOf(fragment.content)}`),
    }),
  );
  return { key, dependencies: dependenciesOf(task, fragments) };
}

/** The accounting split of the accepted fragments. */
function accountingOf(
  request: ContextRequest,
  packed: ReturnType<typeof packContext>,
): ContextAccounting {
  const requested = request.budget.maxTokens;
  return {
    requested,
    fragments: packed.estimate.fragments,
    template: packed.estimate.template,
    safety: packed.estimate.safety,
    used: packed.estimate.used,
    remaining: requested - packed.estimate.used,
    upper: packed.estimate.upper,
    method: packed.estimate.method,
    margin: packed.estimate.margin,
    perFragment: packed.fragments.map((fragment) => ({ id: fragment.id, tokens: fragment.tokens })),
  };
}

/** One omission per ref and reason, in first-seen order. */
function mergeOmissions(...lists: readonly (readonly ContextOmission[])[]): readonly ContextOmission[] {
  const seen = new Set<string>();
  const out: ContextOmission[] = [];
  for (const entry of lists.flat()) {
    const key = `${entry.reason}\u0000${entry.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

/**
 * The Markdown a pack shows for its decisions: one active rule per decision, with its citation and rejected
 * alternatives. A pack with no active rule adds nothing, so a site without decisions is unchanged.
 */
export function renderDecisions(decisions: ContextDecisions | undefined): string {
  if (decisions === undefined || decisions.rules.length === 0) return "";
  const parts = ["## Decisions in effect"];
  for (const rule of decisions.rules) {
    parts.push(`### ${rule.title} (${rule.decision}, ${rule.status})`);
    if (rule.rule !== "") parts.push(rule.rule);
    if (rule.rationale !== undefined && rule.rationale !== "") parts.push(`Why: ${rule.rationale}`);
    if (rule.alternatives.length > 0) {
      const lines = ["Rejected alternatives:"];
      for (const alternative of rule.alternatives) {
        lines.push(`- ${alternative.name}${alternative.rejectedBecause === undefined ? "" : ` — ${alternative.rejectedBecause}`}`);
      }
      parts.push(lines.join("\n"));
    }
    parts.push(`Citation: \`${rule.citation}\` at \`${rule.span}\``);
  }
  return `${parts.join("\n\n")}\n`;
}

/** The omissions and shortages as concrete requests, never as a guess. */
function requestsOf(
  omitted: readonly ContextOmission[],
  answerability: ContextAnswerability,
  accounting: ContextAccounting,
): readonly ContextRequestAction[] {
  const requests: ContextRequestAction[] = [];
  const add = (request: ContextRequestAction): void => {
    if (requests.some((entry) => entry.kind === request.kind && entry.ref === request.ref)) return;
    requests.push(request);
  };

  for (const omission of omitted) {
    if (omission.reason === "scope") {
      add({
        kind: "scope",
        ref: omission.ref,
        detail: omission.detail,
        action: `Add \`${omission.ref}\` to the site or the task scope, then register the task against the new snapshot.`,
      });
    }
    if (omission.reason === "budget" && (omission.answers ?? []).some((ref) => answerability.shortages.includes(ref))) {
      add({
        kind: "approval",
        ref: (omission.answers ?? []).find((ref) => answerability.shortages.includes(ref)) ?? omission.ref,
        detail: omission.detail,
        action: `Approve more context tokens for this task, or narrow the task so \`${omission.ref}\` fits.`,
      });
    }
  }

  for (const ref of answerability.shortages) {
    add({
      kind: "evidence",
      ref,
      detail: `No fragment in this pack answers \`${ref}\`; the pack used ${accounting.used} of ${accounting.requested} tokens.`,
      action: `Supply the file, symbol, or record that proves \`${ref}\`, or widen the task scope to name it.`,
    });
  }
  return requests;
}

/** A permission refusal: no content, every criterion unsatisfied, one approval request. */
function deniedContext(
  task: TaskContract,
  request: ContextRequest,
  kind: import("../contracts/context-request.ts").TaskKind,
  evidence: readonly CriterionEvidence[],
  build: string,
  principal: string,
): CompiledContext {
  const markdown = `# Task context: ${request.task.goal}\n`;
  const cache: ContextCache = {
    key: sha256(canonicalJson({ version: 1, request, taskSnapshot: task.snapshot.id, build, denied: principal })),
    dependencies: [`task:${task.idempotencyKey}`],
  };
  const criteria = task.acceptance.map((criterion): ContextCriterionAnswer => {
    const refs = evidenceRefs(criterion, evidence, scopeRefs(task));
    return {
      id: criterion.id,
      statement: criterion.statement,
      satisfied: false,
      evidence: refs,
      shortage: refs,
    };
  });
  const shortages = [...new Set(criteria.flatMap((criterion) => criterion.shortage))];
  const omitted: ContextOmission[] = [{
    ref: task.idempotencyKey,
    kind: "task",
    reason: "permission",
    detail: `\`${principal}\` is not in \`permissions.read\` for task \`${task.idempotencyKey}\`; no content was read.`,
  }];
  const estimate = estimatePack(markdown, [], markdown);
  const accounting: ContextAccounting = {
    requested: request.budget.maxTokens,
    fragments: estimate.fragments,
    template: estimate.template,
    safety: estimate.safety,
    used: estimate.used,
    remaining: request.budget.maxTokens - estimate.used,
    upper: estimate.upper,
    method: estimate.method,
    margin: estimate.margin,
    perFragment: [],
  };
  return {
    version: 1,
    snapshot: build,
    taskSnapshot: task.snapshot.id,
    task: { idempotencyKey: task.idempotencyKey, goal: task.goal, kind },
    request,
    entries: [],
    dependencies: [],
    fragments: [],
    omitted,
    references: [],
    removedReferences: [],
    accounting,
    answerability: { complete: false, criteria, shortages },
    requests: [{
      kind: "approval",
      ref: `permissions.read:${principal}`,
      detail: `The task does not grant read access to \`${principal}\`.`,
      action: `Add \`${principal}\` to \`permissions.read\` and register the task again.`,
    }],
    cache,
    markdown,
  };
}

/** The diagnostic a rejected cycle or capped closure earns, so a caller sees it on stderr too. */
function reportSelection(selection: ContextSelection, report: ((diagnostic: Diagnostic) => void) | undefined): void {
  if (report === undefined) return;
  for (const cycle of selection.cycles) {
    report({
      id: "context.cycle",
      severity: "warning",
      message: `The dependency closure rejects a cycle: ${cycle.join(" -> ")}.`,
      help: "Remove one link in the cycle, or name the node you need directly in the task scope.",
    });
  }
}

/**
 * Compiles one task into a sourced, budgeted context pack.
 *
 * The task must become a valid request; otherwise this throws {@link ContextCompileError} with every
 * problem, and no content is read. Read permission is checked before the graph: a denied pack has
 * no entries, fragments, or references, and every criterion is unsatisfied.
 */
export async function compileTaskContext(
  site: Site,
  task: TaskContract,
  options: CompileContextOptions = {},
): Promise<CompiledContext> {
  const converted = requestForTask(task, {
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    ...(options.kind === undefined ? {} : { kind: options.kind }),
    ...(options.locale === undefined ? {} : { locale: options.locale }),
    ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
  });
  if ("problems" in converted) throw new ContextCompileError(converted.problems);

  const { request, kind, evidence } = converted;
  const build = buildIdentityOf(site);
  if (!readable(task, options.principal)) {
    return deniedContext(task, request, kind, evidence, build.id, options.principal ?? "");
  }

  const graph = await contextGraphOf(site, {
    ...(options.graph === undefined ? {} : { graph: options.graph }),
    ...(options.root === undefined ? {} : { root: options.root }),
    ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
    ...(options.maxNodes === undefined ? {} : { maxNodes: options.maxNodes }),
    ...(options.allow === undefined ? {} : { allow: options.allow }),
  });
  const selection = selectFromGraph(graph, site, task, {
    ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
    ...(options.maxNodes === undefined ? {} : { maxNodes: options.maxNodes }),
    ...(options.allow === undefined ? {} : { allow: options.allow }),
  });
  reportSelection(selection, options.report);

  const fragments = await fragmentsOf(site, selection, task, build.id);
  const packed = packContext(task.goal, fragments, request.budget.maxTokens);
  const references = taskReferences(site, task, options.lock ?? emptyBlocksLock());
  const answerability = answerabilityOf(task, evidence, packed.fragments);
  const omitted = mergeOmissions(selection.omitted, packed.omitted);
  const accounting = accountingOf(request, packed);
  const cache = cacheOf(request, task, build.id, packed.fragments);
  const decisions = contextDecisionsOf(site, task, {
    ...(options.allow === undefined ? {} : { allow: options.allow }),
  });
  const decisionsMarkdown = renderDecisions(decisions);
  const markdown = decisionsMarkdown === "" ? packed.markdown : `${packed.markdown.replace(/\n$/, "")}\n\n${decisionsMarkdown}`;

  return {
    version: 1,
    snapshot: build.id,
    taskSnapshot: task.snapshot.id,
    task: { idempotencyKey: task.idempotencyKey, goal: task.goal, kind },
    request,
    entries: selection.entries,
    dependencies: selection.dependencies,
    fragments: packed.fragments,
    omitted,
    references: references.references,
    removedReferences: references.removed,
    accounting,
    answerability,
    requests: requestsOf(omitted, answerability, accounting),
    cache,
    ...(decisions.rules.length === 0 && decisions.history.length === 0 && decisions.withheld.length === 0 ? {} : { decisions }),
    markdown,
  };
}

/** Why a pack changed between two builds or two task snapshots. */
export type ContextChangeReason = "snapshot" | "rule" | "budget" | "selection";

/** One added, removed, or changed fragment, described by identity and hashes only. */
export interface ContextDiffEntry {
  readonly id: string;
  readonly kind: ContextFragment["kind"];
  readonly title: string;
  readonly change: "added" | "removed" | "changed";
  readonly reasons: readonly ContextChangeReason[];
  /** The source file, when the fragment has one; never the fragment's text. */
  readonly source?: string;
}

/** The comparison of two packs: no content from either, so an unauthorized text cannot leak. */
export interface ContextDiff {
  readonly added: readonly ContextDiffEntry[];
  readonly removed: readonly ContextDiffEntry[];
  readonly changed: readonly ContextDiffEntry[];
  readonly snapshotChanged: boolean;
  readonly taskSnapshotChanged: boolean;
  readonly ruleChanged: boolean;
  readonly budgetChanged: boolean;
}

/** The fingerprints a diff reads: id, kind, title, source file, and content hash. */
function fingerprintOf(context: CompiledContext): ReadonlyMap<string, { readonly kind: ContextFragment["kind"]; readonly title: string; readonly source?: string; readonly hash: string }> {
  return new Map(
    context.fragments.map((fragment) => [
      fragment.id,
      {
        kind: fragment.kind,
        title: fragment.title,
        ...(fragment.source.file === "" ? {} : { source: fragment.source.file }),
        hash: hashOf(fragment.content),
      },
    ]),
  );
}

/**
 * Compares two packs by fragment identity and content hash, and explains the change class.
 *
 * Only ids, titles, kinds, source files, and hashes are compared or reported. A removed private
 * field never existed in either pack, and a changed fragment's text is not copied into the diff.
 */
export function diffContextPacks(before: CompiledContext, after: CompiledContext): ContextDiff {
  const left = fingerprintOf(before);
  const right = fingerprintOf(after);
  const added: ContextDiffEntry[] = [];
  const removed: ContextDiffEntry[] = [];
  const changed: ContextDiffEntry[] = [];
  const snapshotChanged = before.snapshot !== after.snapshot;
  const taskSnapshotChanged = before.taskSnapshot !== after.taskSnapshot;
  const ruleChanged =
    before.fragments.some((fragment) => fragment.kind === "lineage") !==
      after.fragments.some((fragment) => fragment.kind === "lineage") ||
    before.fragments.filter((fragment) => fragment.kind === "lineage").some((fragment) => {
      const other = after.fragments.find((candidate) => candidate.id === fragment.id);
      return other !== undefined && hashOf(other.content) !== hashOf(fragment.content);
    });
  const budgetChanged = before.accounting.requested !== after.accounting.requested;

  const reasonsFor = (): readonly ContextChangeReason[] => {
    const reasons: ContextChangeReason[] = [];
    if (snapshotChanged) reasons.push("snapshot");
    if (ruleChanged) reasons.push("rule");
    if (budgetChanged) reasons.push("budget");
    if (reasons.length === 0) reasons.push("selection");
    return reasons;
  };

  for (const [id, value] of left) {
    const other = right.get(id);
    if (other === undefined) {
      removed.push({ id, kind: value.kind, title: value.title, change: "removed", reasons: reasonsFor(), ...(value.source === undefined ? {} : { source: value.source }) });
      continue;
    }
    if (other.hash !== value.hash) {
      changed.push({ id, kind: value.kind, title: value.title, change: "changed", reasons: reasonsFor(), ...(value.source === undefined ? {} : { source: value.source }) });
    }
  }
  for (const [id, value] of right) {
    if (left.has(id)) continue;
    added.push({ id, kind: value.kind, title: value.title, change: "added", reasons: reasonsFor(), ...(value.source === undefined ? {} : { source: value.source }) });
  }
  return { added, removed, changed, snapshotChanged, taskSnapshotChanged, ruleChanged, budgetChanged };
}

/** A refill: only the fragments that were not already in the previous pack, with their reasons. */
export interface ContextRefill {
  /** True when both the docs and the task inputs are unchanged. */
  readonly unchanged: boolean;
  /** The new fragments only; empty when the snapshot is unchanged. */
  readonly fragments: readonly ContextFragment[];
  /** Why each new fragment appeared: its `reason` and the dependency edges that reached it. */
  readonly reasons: readonly { readonly id: string; readonly reason: string; readonly via: readonly string[] }[];
}

/** The new fragments after `before`, and nothing when the docs and task inputs did not change. */
export function refillContext(before: CompiledContext, after: CompiledContext): ContextRefill {
  if (before.snapshot === after.snapshot && before.taskSnapshot === after.taskSnapshot) {
    return { unchanged: true, fragments: [], reasons: [] };
  }
  const previous = fingerprintOf(before);
  const fragments = after.fragments.filter((fragment) => {
    const old = previous.get(fragment.id);
    return old === undefined || old.hash !== hashOf(fragment.content);
  });
  return {
    unchanged: false,
    fragments,
    reasons: fragments.map((fragment) => ({
      id: fragment.id,
      reason: fragment.reason,
      via: fragment.via,
    })),
  };
}

/** One cached pack and the inputs it read. */
export interface ContextCacheEntry {
  readonly key: string;
  readonly dependencies: readonly string[];
}

/** A cache lookup: the same key is a byte-identical reuse, a different one is a rebuild. */
export function refreshContext(before: CompiledContext, after: CompiledContext): {
  readonly reused: boolean;
  readonly context: CompiledContext;
} {
  return after.cache.key === before.cache.key
    ? { reused: true, context: before }
    : { reused: false, context: after };
}

/**
 * Which cached packs a changed file invalidates: only those whose dependency list names it.
 *
 * A page edit changes the build id, but a pack that never read that page still has the same
 * fragments; its cache key changes only because the id is published, so this function answers the
 * narrower question a refresh plan asks — which packs must be recompiled for this file.
 */
export function invalidatedContexts(
  entries: readonly ContextCacheEntry[],
  changedFiles: readonly string[],
): readonly string[] {
  const changed = new Set(changedFiles.map((file) => `file:${file.replace(/\\/g, "/").replace(/^\/+/, "")}`));
  return entries
    .filter((entry) => entry.dependencies.some((dependency) => changed.has(dependency)))
    .map((entry) => entry.key)
    .sort();
}

/** A stable JSON form of a compilation, byte-identical for the same bytes. */
export function contextJson(context: CompiledContext): string {
  return `${JSON.stringify(context, null, 2)}\n`;
}
