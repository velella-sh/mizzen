/**
 * Turn documentation gaps into authoring tasks (#1407): one task per item the report calls partial or undocumented,
 * carrying the public surface item, its introduction version, the evidence a draft must cite, the recommended page
 * type, the evidence-first outline, explicit unknowns, reviewer questions, and the proposed location.
 *
 * A documented exclusion never becomes a task. It is kept in `skipped` with the author's reason, so the absence of a
 * task is explained rather than silent. The task is registered through the ordinary task contract, with one
 * acceptance criterion per check the verification later runs.
 */
import type { Site, TaskBudget, TaskDocument, TaskProblem, TaskScope } from "../contracts/index.ts";
import type { SurfaceGap, SurfaceItem, SurfaceReport } from "../contracts/surface.ts";
import type {
  AuthoringConflict,
  AuthoringEvidenceRef,
  AuthoringPurpose,
  AuthoringQuestion,
  AuthoringSkip,
  AuthoringSurfaceItem,
  AuthoringTask,
  AuthoringTaskList,
  AuthoringUnknown,
} from "../contracts/authoring.ts";
import type { BehaviorRecord } from "../contracts/behavior.ts";
import { behaviorReportOf } from "../behavior/report.ts";
import { canonicalJson, sha256 } from "../data/lock.ts";
import { registerTask } from "../tasks/register.ts";
import { taskSnapshot } from "../tasks/snapshot.ts";
import { emptyScope } from "../tasks/scope.ts";
import { formatSpan } from "../source/spans.ts";
import { locationConflicts, proposeLocation, urlWithoutBase } from "./location.ts";
import { limitationsOf, outlineOf } from "./outline.ts";
import { recommendPageType } from "./type.ts";

/** The check ids every authoring task names, in verification order. */
export const AUTHORING_CHECKS: readonly string[] = [
  "authoring-citations",
  "authoring-examples",
  "authoring-behaviors",
  "authoring-links",
  "authoring-coverage",
  "authoring-build",
];

/** What one task run needs. */
export interface AuthoringTaskOptions {
  /** The site root, so behavior tests and evidence can be resolved. */
  readonly root: string;
  readonly site: Site;
  readonly report: SurfaceReport;
  /** The product version the surface was inventoried at, when one is known. */
  readonly version?: string;
  /** The task input snapshot; computed from the site when absent. */
  readonly snapshot?: TaskDocument["snapshot"];
  /** An explicit purpose for every gap; without it the purpose is derived from the surface kind. */
  readonly purpose?: AuthoringPurpose;
  /** Only these surface ids; without it every gap in the report becomes a task. */
  readonly items?: readonly string[];
  readonly budget?: TaskBudget;
  /** Tasks already registered, so a repeated run returns the same task instead of a duplicate. */
  readonly existing?: readonly TaskDocument[];
}

/** The result of proposing authoring tasks. */
export interface AuthoringTaskResult {
  readonly list: AuthoringTaskList;
  readonly problems: readonly TaskProblem[];
}

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A SHA-256 of one part of the site. */
function hashPart(value: unknown): string {
  return sha256(canonicalJson(value));
}

/**
 * A deterministic task snapshot for one built site and tool version. The four hashes cover the page sources, the
 * effective data, the effective config, and the tooling, so a change to any of them gives a different task id.
 */
export function authoringSnapshot(site: Site, version: string): TaskDocument["snapshot"] {
  return taskSnapshot({
    content: hashPart(site.pages.map((page) => ({ file: page.source.file, url: page.url, markdown: page.markdown }))),
    data: hashPart({ data: site.data, collections: site.collections }),
    config: hashPart(site.config),
    tooling: sha256(`mizzen-tooling\0${version}`),
  });
}

/** The public surface item as a task carries it. */
function surfaceOf(item: SurfaceItem): AuthoringSurfaceItem {
  return {
    id: item.id,
    area: item.area,
    kind: item.kind,
    name: item.name,
    stability: item.stability,
    source: item.source,
    ...(item.signature === undefined ? {} : { signature: item.signature }),
    introduced: item.version?.introduced ?? "unknown",
  };
}

/** Every behavior whose surface links name this item. */
function behaviorsFor(item: string, behaviors: readonly BehaviorRecord[]): BehaviorRecord[] {
  return behaviors
    .filter((behavior) => behavior.surface.some((link) => link.item === item))
    .sort((a, b) => byCodePoint(a.id, b.id));
}

/** The evidence a draft must cite: the surface, each behavior, each test and evidence link, and the declaration. */
function requiredEvidenceOf(item: AuthoringSurfaceItem, behaviors: readonly BehaviorRecord[]): AuthoringEvidenceRef[] {
  const evidence: AuthoringEvidenceRef[] = [
    { kind: "surface", ref: item.id, detail: `The public surface declaration of ${item.id}.` },
    {
      kind: "source",
      ref: `${item.source.file}:${item.source.line}`,
      detail: `The declaration span ${formatSpan(item.source)}.`,
    },
  ];
  for (const behavior of behaviors) {
    evidence.push({ kind: "behavior", ref: behavior.id, detail: `Behavior \`${behavior.title}\`.` });
    for (const test of behavior.tests) {
      evidence.push({ kind: "test", ref: test.file, detail: `Test \`${test.file}\` is expected to ${test.outcome}.` });
    }
    for (const link of behavior.evidence) {
      const ref = link.id ?? link.url;
      if (ref !== undefined) evidence.push({ kind: "evidence", ref, detail: `Evidence for \`${behavior.id}\`.` });
    }
  }
  const unique = new Map<string, AuthoringEvidenceRef>();
  for (const entry of evidence) unique.set(`${entry.kind}\0${entry.ref}`, entry);
  return [...unique.values()].sort((a, b) => byCodePoint(a.kind, b.kind) || byCodePoint(a.ref, b.ref));
}

/** The explicit unknowns a gap carries: an unknown version, a missing behavior, an unverified behavior, weak docs. */
function unknownsOf(
  item: AuthoringSurfaceItem,
  gap: SurfaceGap,
  behaviors: readonly BehaviorRecord[],
): AuthoringUnknown[] {
  const unknowns: AuthoringUnknown[] = [];
  if (item.introduced === "unknown") {
    unknowns.push({
      id: "version-introduced",
      statement: `The product version that introduced \`${item.id}\` is unknown.`,
      evidence: `The release tag, changelog entry, or commit that first names \`${item.name}\`.`,
    });
  }
  if (behaviors.length === 0) {
    unknowns.push({
      id: "behavior-contract",
      statement: `No behavior contract links \`${item.id}\`, so its supported behavior is not established.`,
      evidence: `A behavior declaration whose \`surface\` names \`${item.id}\`.`,
    });
  }
  for (const behavior of behaviors) {
    if (behavior.verification.status !== "verified") {
      unknowns.push({
        id: `behavior-${behavior.id}`,
        statement: `Behavior \`${behavior.id}\` is unverified: ${behavior.verification.reasons.join(", ")}.`,
        evidence: "The tests and evidence the published policy requires.",
      });
    }
  }
  if (gap.gap === "partial") {
    unknowns.push({
      id: "partial-documentation",
      statement: `Existing documentation names \`${item.id}\` only weakly.`,
      evidence: "A strong link, inline code reference, or `file:line` reference.",
    });
  }
  return unknowns.sort((a, b) => byCodePoint(a.id, b.id));
}

/** The questions a reviewer must answer, derived from the same gaps. */
function questionsOf(
  item: AuthoringSurfaceItem,
  behaviors: readonly BehaviorRecord[],
  unknowns: readonly AuthoringUnknown[],
): AuthoringQuestion[] {
  const questions: AuthoringQuestion[] = [
    { id: "audience-version", question: `Which audience and product version should the page for \`${item.id}\` target?` },
  ];
  if (item.introduced === "unknown") {
    questions.push({ id: "version-introduced", question: `Which release introduced \`${item.id}\`?` });
  }
  if (!behaviors.some((behavior) => behavior.tests.length > 0)) {
    questions.push({ id: "canonical-example", question: `Which example is the canonical demonstration of \`${item.name}\`?` });
  }
  if (behaviors.some((behavior) => behavior.verification.status !== "verified")) {
    questions.push({ id: "behavior-evidence", question: `Which test or CI run proves the behavior of \`${item.name}\`?` });
  }
  if (unknowns.some((unknown) => unknown.id === "partial-documentation")) {
    questions.push({ id: "partial-scope", question: `Which parts of the existing documentation for \`${item.name}\` are complete?` });
  }
  return questions.sort((a, b) => byCodePoint(a.id, b.id));
}

/** The task scope: the page to write, its block, and the source facts the task reads. */
function scopeOf(item: AuthoringSurfaceItem, url: string, block: string, source: string): TaskScope {
  return {
    ...emptyScope(),
    pages: [url],
    blocks: [block],
    collections: item.kind === "collection" || item.kind === "field" ? [item.name.split(".")[0]!] : [],
    symbols: item.kind === "symbol" ? [item.name] : [],
    files: [source, item.source.file].filter((file, index, all) => all.indexOf(file) === index),
  };
}

/** The acceptance criteria every authoring task carries, one per check. */
function acceptanceOf(item: AuthoringSurfaceItem): TaskDocument["acceptance"] {
  return [
    {
      id: "citations",
      statement: `Every normative claim about \`${item.id}\` cites the surface, a behavior, or evidence.`,
      check: "authoring-citations",
    },
    {
      id: "examples",
      statement: `Every runnable example for \`${item.id}\` prints its recorded output.`,
      check: "authoring-examples",
    },
    {
      id: "behaviors",
      statement: `Every cited behavior of \`${item.id}\` is verified by the published evidence policy.`,
      check: "authoring-behaviors",
    },
    {
      id: "links",
      statement: `Every link and citation in the page for \`${item.id}\` resolves.`,
      check: "authoring-links",
    },
    {
      id: "coverage",
      statement: `The simulated merge leaves \`${item.id}\` completely documented.`,
      check: "authoring-coverage",
    },
    {
      id: "build",
      statement: `The site builds with the page and writes it for \`${item.id}\`.`,
      check: "authoring-build",
    },
  ];
}

/** The contract input one task registers. */
function contractInput(
  item: AuthoringSurfaceItem,
  pageType: AuthoringTask["pageType"],
  location: AuthoringTask["location"],
  snapshot: TaskDocument["snapshot"],
  budget: TaskBudget,
): object {
  return {
    version: 1,
    idempotencyKey: `authoring:${item.id}:${snapshot.id}`,
    goal: `Document ${item.id} as a ${pageType.kind}: ${pageType.reason}`,
    scope: scopeOf(item, location.url, location.block, location.source),
    snapshot,
    budget,
    permissions: { read: ["*"], write: ["authoring"], check: ["authoring"] },
    acceptance: acceptanceOf(item),
  };
}

/** Append a conflict to a task once. */
function addConflict(task: AuthoringTask, conflict: AuthoringConflict): AuthoringTask {
  if (task.conflicts.some((entry) => entry.kind === conflict.kind && entry.value === conflict.value)) return task;
  return { ...task, conflicts: [...task.conflicts, conflict].sort((a, b) => byCodePoint(a.kind, b.kind) || byCodePoint(a.value, b.value)) };
}

/**
 * Creates one authoring task per gap. Exclusions are skipped with their reason. Locations are checked against the site
 * first, then against the other tasks in the same run, so two items that would share a URL, block id, or nav entry
 * both carry the conflict before a draft is written.
 */
export async function authoringTasksOf(options: AuthoringTaskOptions): Promise<AuthoringTaskResult> {
  const { root, site, report } = options;
  const version = options.version ?? "0.2.7";
  const snapshot = options.snapshot ?? authoringSnapshot(site, version);
  const budget = options.budget ?? { contextTokens: 12_000, toolCalls: 30, timeMs: 300_000 };
  const known = [...(options.existing ?? [])];
  const items = new Map(report.items.map((item) => [item.id, item]));
  const behaviorReport = await behaviorReportOf({ site, root, ...(options.version === undefined ? {} : { version: options.version }) });
  const tasks: AuthoringTask[] = [];
  const problems: TaskProblem[] = [];
  const skipped: AuthoringSkip[] = [];

  const gaps = [...report.gaps]
    .filter((gap) => options.items === undefined || options.items.includes(gap.item))
    .sort((a, b) => byCodePoint(a.area, b.area) || byCodePoint(a.item, b.item));
  for (const item of options.items ?? []) {
    if (!report.items.some((candidate) => candidate.id === item)) {
      skipped.push({ item, reason: "The surface report does not contain this item." });
    } else if (!report.gaps.some((candidate) => candidate.item === item) && !report.exclusions.some((candidate) => candidate.id === item)) {
      skipped.push({ item, reason: "The item is already completely documented." });
    }
  }
  for (const gap of gaps) {
    const raw = items.get(gap.item);
    if (raw === undefined) {
      problems.push({
        path: `/gaps/${gap.item}`,
        code: "authoring.gap-without-item",
        message: `The gap \`${gap.item}\` has no matching surface item.`,
      });
      continue;
    }
    const item = surfaceOf(raw);
    const behaviors = behaviorsFor(item.id, behaviorReport.report.behaviors);
    const pageType = recommendPageType(item, gap.gap, options.purpose);
    const location = proposeLocation(item, pageType.kind, site);
    const requiredEvidence = requiredEvidenceOf(item, behaviors);
    const unknowns = unknownsOf(item, gap, behaviors);
    const questions = questionsOf(item, behaviors, unknowns);
    const limitations = limitationsOf(item, behaviors, unknowns);
    const outline = outlineOf({ item, pageType: pageType.kind, behaviors, requiredEvidence, unknowns, questions });

    const result = registerTask(
      contractInput(item, pageType, location, snapshot, budget),
      { checks: [...AUTHORING_CHECKS], existing: known },
    );
    if (result.task === undefined) {
      problems.push(...result.problems);
      continue;
    }
    if (result.created) known.push(result.task);
    const task: AuthoringTask = {
      version: 1,
      task: result.task,
      item: item.id,
      surface: item,
      gap: gap.gap,
      requiredEvidence,
      pageType,
      outline,
      location,
      unknowns,
      questions,
      limitations,
      conflicts: locationConflicts(location, site),
    };
    tasks.push(task);
  }

  for (const exclusion of report.exclusions) {
    skipped.push({ item: exclusion.id, reason: `Documented exclusion: ${exclusion.reason}` });
  }
  const uniqueSkips = [...new Map(skipped.map((entry) => [entry.item, entry])).values()];

  // A location proposed twice is a conflict for both tasks, whichever was generated first.
  const byUrl = new Map<string, AuthoringTask[]>();
  const byBlock = new Map<string, AuthoringTask[]>();
  for (const task of tasks) {
    const key = urlWithoutBase(task.location.url, site);
    byUrl.set(key, [...(byUrl.get(key) ?? []), task]);
    byBlock.set(task.location.block, [...(byBlock.get(task.location.block) ?? []), task]);
  }
  const withDuplicates = tasks.map((task) => {
    let next = task;
    const url = urlWithoutBase(task.location.url, site);
    for (const other of byUrl.get(url) ?? []) {
      if (other.item === task.item) continue;
      next = addConflict(next, {
        kind: "slug",
        value: task.location.url,
        message: `The URL \`${task.location.url}\` is also proposed for \`${other.item}\`.`,
      });
    }
    for (const other of byBlock.get(task.location.block) ?? []) {
      if (other.item === task.item) continue;
      next = addConflict(next, {
        kind: "block",
        value: task.location.block,
        message: `The block id \`${task.location.block}\` is also proposed for \`${other.item}\`.`,
      });
    }
    return next;
  });

  return {
    list: {
      version: 1,
      source: options.version === undefined ? {} : { version: options.version },
      tasks: withDuplicates.sort((a, b) => byCodePoint(a.item, b.item)),
      skipped: uniqueSkips.sort((a, b) => byCodePoint(a.item, b.item)),
    },
    problems,
  };
}

/** The task for one surface item, or `undefined`. */
export function authoringTaskFor(list: AuthoringTaskList, item: string): AuthoringTask | undefined {
  return list.tasks.find((task) => task.item === item);
}

/** Every outline section of one task that still needs evidence. */
export function taskNeedsEvidence(task: AuthoringTask): readonly string[] {
  return task.outline.filter((section) => section.needsEvidence).map((section) => section.heading);
}
