/**
 * Turn documentation drift into maintenance tasks (#1230), decide whether the work needs a model
 * (#1231), and keep the scope to the drifted pages and files (#1232).
 *
 * Observations come from the existing drift, stale, and data-impact output. Each group becomes a
 * goal, a semantic scope, and one acceptance criterion; a record with no published output and a
 * page with no finding produce no task. A finding whose diagnostic already carries a mechanical
 * fix is handled deterministically; a stale page, a data-impact change, or a finding without a fix
 * is semantic work for an agent. The scope is derived from the observations alone, then filtered
 * by the caller's site permissions, so an unrelated file cannot join a task by accident.
 */
import type { AccessPolicy } from "../contracts/permissions.ts";
import type { TaskBudget, TaskProblem, TaskScope } from "../contracts/task.ts";
import type {
  MaintenanceDecision,
  MaintenanceFinding,
  MaintenanceObservations,
  MaintenanceScopeResult,
  MaintenanceSkip,
  MaintenanceTask,
  MaintenanceTaskResult,
  TaskSnapshot,
} from "../contracts/index.ts";
import { canonicalJson, sha256 } from "../data/lock.ts";
import { writeRule } from "../permissions/evaluate.ts";
import { registerTask } from "../tasks/register.ts";
import { emptyScope } from "../tasks/scope.ts";

/** What task registration needs besides the observations. */
export interface ProposeOptions {
  /** The input snapshot the drift was observed against. */
  readonly snapshot: TaskSnapshot;
  /** Tasks already known; a matching key returns the existing task. */
  readonly existing?: readonly MaintenanceTask["task"][];
  /** The check an acceptance criterion names. Default `site`. */
  readonly check?: string;
  readonly budget?: TaskBudget;
  /** Site permissions: pages a task may touch; absent means every observed page. */
  readonly allowedPages?: readonly string[];
  /** Site permissions: files a task may touch; absent means every observed file. */
  readonly allowedFiles?: readonly string[];
  /** A site access policy; its write rule must allow each file. */
  readonly policy?: AccessPolicy;
  /** The task id the policy decisions use; defaults to the policy's own task. */
  readonly task?: string;
}

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** True when the observations have a finding, stale page, or impact that reaches output. */
function meaningfulImpact(impact: MaintenanceObservations["impact"][number]): boolean {
  return impact.outputs.length > 0 && impact.pages.length > 0;
}

/** Every observation group that can become a task. */
function groups(observations: MaintenanceObservations): {
  readonly stale: { readonly page: string; readonly files: readonly string[] }[];
  readonly findings: { readonly page: string; readonly entries: readonly MaintenanceFinding[] }[];
  readonly impact: MaintenanceObservations["impact"];
} {
  const stale = observations.staleness
    .filter((entry) => entry.files.length > 0)
    .map((entry) => ({ page: entry.page, files: entry.files.map((file) => file.path).sort(byCodePoint) }))
    .sort((a, b) => byCodePoint(a.page, b.page));

  const byPage = new Map<string, MaintenanceFinding[]>();
  for (const finding of observations.findings) {
    const list = byPage.get(finding.page) ?? [];
    list.push(finding);
    byPage.set(finding.page, list);
  }
  const findings = [...byPage.entries()]
    .sort(([a], [b]) => byCodePoint(a, b))
    .map(([page, entries]) => ({ page, entries: [...entries].sort((a, b) => byCodePoint(a.id, b.id)) }));

  const impact = observations.impact.filter(meaningfulImpact);
  return { stale, findings, impact };
}

/**
 * Whether the observed drift needs an agent. A diagnostic with a safe mechanical repair never
 * does; a stale page, a data-impact change, or a finding without a fix needs a model to read the
 * prose and decide what the change means.
 */
export function decideMaintenance(observations: MaintenanceObservations): MaintenanceDecision {
  const { stale, findings, impact } = groups(observations);
  const fixes: string[] = [];
  const semantic: string[] = [];
  for (const group of findings) {
    for (const finding of group.entries) {
      if (finding.fix !== undefined) fixes.push(finding.id);
      else semantic.push(finding.id);
    }
  }
  const semanticCount = semantic.length + stale.length + impact.length;
  if (semanticCount > 0) {
    const parts = [
      semantic.length > 0 ? `${semantic.length} finding(s) without a mechanical repair` : "",
      stale.length > 0 ? `${stale.length} stale page(s)` : "",
      impact.length > 0 ? `${impact.length} data change(s) with published impact` : "",
    ].filter((part) => part !== "");
    return {
      mode: "agent",
      reason: `A model is needed for ${parts.join(", ")}; a deterministic fix cannot decide what the prose should say.`,
      fixes: [...new Set(fixes)].sort(byCodePoint),
      semantic: [...new Set(semantic)].sort(byCodePoint),
    };
  }
  if (fixes.length > 0) {
    return {
      mode: "deterministic",
      reason: `${fixes.length} finding(s) carry a safe mechanical repair; apply it without a model.`,
      fixes: [...new Set(fixes)].sort(byCodePoint),
      semantic: [],
    };
  }
  return { mode: "none", reason: "No drift needs maintenance; no task is proposed.", fixes: [], semantic: [] };
}

/** Every mechanical repair the drift checks already know, in observation order. */
export function deterministicFixes(observations: MaintenanceObservations): readonly MaintenanceFinding[] {
  return observations.findings
    .filter((finding) => finding.fix !== undefined)
    .slice()
    .sort((a, b) => byCodePoint(a.page, b.page) || byCodePoint(a.id, b.id));
}

/**
 * Keeps only the resources the observations produced and the site allows. A page or file outside
 * the observed drift is never in the answer, and a policy denial is named rather than silently
 * dropped.
 */
export function constrainMaintenanceScope(
  scope: TaskScope,
  options: Omit<ProposeOptions, "snapshot" | "existing" | "check" | "budget"> = {},
): MaintenanceScopeResult {
  const excluded: { ref: string; reason: string }[] = [];
  const pageAllowed = (page: string): boolean =>
    options.allowedPages === undefined || options.allowedPages.includes(page);
  const fileAllowed = (file: string): boolean =>
    options.allowedFiles === undefined || options.allowedFiles.includes(file);

  const pages = scope.pages.filter((page) => {
    if (pageAllowed(page)) return true;
    excluded.push({ ref: page, reason: "page is outside the site permission list" });
    return false;
  });
  const files = scope.files.filter((file) => {
    if (!fileAllowed(file)) {
      excluded.push({ ref: file, reason: "file is outside the site permission list" });
      return false;
    }
    if (options.policy !== undefined && !options.policy.capabilities.write) {
      excluded.push({ ref: file, reason: "the access policy denies write" });
      return false;
    }
    if (options.policy !== undefined) {
      const decision = writeRule(options.policy, {
        capability: "write",
        task: options.task ?? options.policy.task,
        snapshot: "",
        path: file,
        scope,
      });
      if (!decision.allowed) {
        excluded.push({ ref: file, reason: decision.rule });
        return false;
      }
    }
    return true;
  });

  return { scope: { ...scope, pages, files }, excluded };
}

/** The task id of one observation group and snapshot. */
export function proposalIdOf(trigger: string, snapshot: TaskSnapshot): string {
  return sha256(`mizzen-maintenance-task\0${canonicalJson({ trigger, snapshot: snapshot.id })}`);
}

/** One task input before registration. */
function taskInput(
  trigger: string,
  goal: string,
  scope: TaskScope,
  statement: string,
  snapshot: TaskSnapshot,
  check: string,
  budget: TaskBudget,
): object {
  return {
    version: 1,
    idempotencyKey: `maintenance:${trigger}:${snapshot.id}`,
    goal,
    scope,
    snapshot,
    budget,
    permissions: { read: ["*"], write: ["maintenance"], check: ["maintenance"] },
    acceptance: [{ id: "current", statement, check }],
  };
}

/** A page source is a safe relative path. */
function pageFile(page: string): string | undefined {
  if (page === "" || page.startsWith("/") || page.includes("\\")) return undefined;
  if (page.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) return undefined;
  return page;
}

/**
 * Proposes one task per drifted page or impacted record. A no-impact record, an empty finding
 * list, and a stale page with no changed file are skipped with a reason; the same observation and
 * snapshot returns the same existing task instead of a duplicate.
 */
export function proposeMaintenanceTasks(
  observations: MaintenanceObservations,
  options: ProposeOptions,
): MaintenanceTaskResult {
  const tasks: MaintenanceTask[] = [];
  const skipped: MaintenanceSkip[] = [];
  const problems: TaskProblem[] = [];
  if (observations.version !== 1) {
    problems.push({
      path: "/version",
      code: "maintenance.observations-version",
      message: "Only maintenance observations version 1 are supported.",
    });
    return { tasks, skipped, problems };
  }

  const check = options.check ?? "site";
  const budget = options.budget ?? { contextTokens: 12000, toolCalls: 30, timeMs: 300_000 };
  const known = [...(options.existing ?? [])];
  const { stale, findings, impact } = groups(observations);

  const register = (trigger: string, goal: string, rawScope: TaskScope, statement: string): void => {
    const constrained = constrainMaintenanceScope(rawScope, options);
    if (isEmpty(constrained.scope)) {
      skipped.push({
        kind: trigger.startsWith("stale:") ? "stale" : trigger.startsWith("impact:") ? "impact" : "finding",
        source: trigger,
        reason: constrained.excluded.length > 0
          ? `every resource is excluded: ${constrained.excluded.map((entry) => `${entry.ref} (${entry.reason})`).join(", ")}`
          : "the observation names no resource a task may touch",
      });
      return;
    }
    const result = registerTask(
      taskInput(trigger, goal, constrained.scope, statement, options.snapshot, check, budget),
      { existing: known, checks: [check] },
    );
    if (result.task === undefined) {
      problems.push(...result.problems);
      return;
    }
    if (result.created) known.push(result.task);
    tasks.push({
      version: 1,
      id: proposalIdOf(trigger, options.snapshot),
      trigger,
      created: result.created,
      task: result.task,
    });
  };

  for (const page of stale) {
    const scope: TaskScope = { ...emptyScope(), pages: [page.page], files: page.files };
    register(
      `stale:${page.page}`,
      `Review ${page.page} after its covered files changed: ${page.files.join(", ")}.`,
      scope,
      `The page no longer contradicts its covered files: ${page.files.join(", ")}.`,
    );
  }

  for (const group of findings) {
    const files = [...new Set(group.entries.map((entry) => entry.pos?.file ?? pageFile(group.page)).filter((file): file is string => file !== undefined))];
    const scope: TaskScope = { ...emptyScope(), pages: [group.page], files: files.sort(byCodePoint) };
    const ids = [...new Set(group.entries.map((entry) => entry.id))].sort(byCodePoint);
    register(
      `finding:${group.page}:${ids.join(",")}`,
      `Repair ${ids.join(", ")} in ${group.page}.`,
      scope,
      `Every drift finding in ${group.page} is cleared: ${ids.join(", ")}.`,
    );
  }

  for (const entry of impact) {
    const pages = [...new Set(entry.pages)].sort(byCodePoint);
    const scope: TaskScope = { ...emptyScope(), pages, collections: [entry.collection] };
    register(
      `impact:${entry.collection}:${entry.record}`,
      `Update the documentation affected by ${entry.collection}/${entry.record}; its change reaches ${entry.outputs.length} published output(s).`,
      scope,
      `The pages that describe ${entry.record} agree with the new data, and ${entry.outputs.length} published output(s) remain valid.`,
    );
  }

  for (const entry of observations.impact) {
    if (!meaningfulImpact(entry)) {
      skipped.push({
        kind: "impact",
        source: `${entry.collection}/${entry.record}`,
        reason: entry.outputs.length === 0
          ? "the record has no published output, so it has no documentation impact"
          : "no documentation page describes the record, so there is nothing to update",
      });
    }
  }

  return { tasks, skipped, problems };
}

/** True when every list of a scope is empty. */
function isEmpty(scope: TaskScope): boolean {
  return (
    scope.pages.length + scope.blocks.length + scope.collections.length + scope.symbols.length + scope.files.length === 0
  );
}
