/**
 * Versioned maintenance triggers (#1229).
 *
 * A trigger is one changed input — a covered file, a schema, an API, or a data record — with the
 * input snapshot it was read against. Its id covers the kind, source, change, new hash, and
 * snapshot, so repeating the same event gives the same id and the same task; a later change with a
 * different hash is a new event and a new task. Nothing here reads a clock, a path, or the network:
 * the caller supplies the change list and the effective snapshot.
 */
import type { TaskBudget, TaskProblem } from "../contracts/task.ts";
import type {
  MaintenanceChange,
  MaintenanceKind,
  MaintenanceTask,
  MaintenanceTaskResult,
  MaintenanceTrigger,
  MaintenanceTriggerResult,
  TaskSnapshot,
} from "../contracts/index.ts";
import { canonicalJson, sha256 } from "../data/lock.ts";
import { registerTask } from "../tasks/register.ts";
import { taskIdOf } from "../tasks/identity.ts";
import { snapshotIdOf } from "../tasks/snapshot.ts";

const HASH = /^[0-9a-f]{64}$/u;
const KINDS: readonly MaintenanceKind[] = ["file", "schema", "api", "data"];
const CHANGES = ["added", "changed", "removed"] as const;

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** True for a value this module accepts as one of its kinds. */
function isKind(value: unknown): value is MaintenanceKind {
  return typeof value === "string" && (KINDS as readonly string[]).includes(value);
}

/** True for a non-empty relative path or id without an escape segment. */
function isSource(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() === "") return false;
  if (value.includes("\\") || value.startsWith("/")) return false;
  return !value.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

/** The past tense of a change, for a sentence a goal can use. */
const PAST: Readonly<Record<MaintenanceChange["change"], string>> = {
  added: "added",
  changed: "changed",
  removed: "removed",
};

/** The sentence a trigger carries when the caller supplies none. */
function defaultDetail(change: MaintenanceChange): string {
  return `${change.source} was ${PAST[change.change]}.`;
}

/**
 * Every input that differs between two hash maps, sorted by source. `kindOf` classifies each path;
 * it defaults to `file`. A removed input has no new hash.
 */
export function maintenanceChanges(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
  kindOf: (source: string) => MaintenanceKind = () => "file",
): MaintenanceChange[] {
  const sources = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort(byCodePoint);
  const changes: MaintenanceChange[] = [];
  for (const source of sources) {
    const was = before[source];
    const now = after[source];
    if (was === now) continue;
    const kind = kindOf(source);
    if (was === undefined) {
      if (now !== undefined) changes.push({ kind, source, change: "added", sha256: now });
    } else if (now === undefined) changes.push({ kind, source, change: "removed" });
    else changes.push({ kind, source, change: "changed", sha256: now });
  }
  return changes;
}

/**
 * Turns changes into unique versioned triggers. A repeated event (same kind, source, change,
 * hash, and snapshot) is reported once in `duplicates` and never becomes a second trigger.
 */
export function maintenanceTriggers(
  changes: readonly MaintenanceChange[],
  snapshot: TaskSnapshot,
): MaintenanceTriggerResult {
  const problems: TaskProblem[] = [];
  const byId = new Map<string, MaintenanceTrigger>();
  const duplicates: string[] = [];

  changes.forEach((change, index) => {
    const path = `/changes/${index}`;
    if (!isKind(change.kind)) {
      problems.push({
        path: `${path}/kind`,
        code: "maintenance.trigger-kind",
        message: `Unknown trigger kind \`${String(change.kind)}\`; use one of: ${KINDS.map((kind) => `\`${kind}\``).join(", ")}.`,
      });
      return;
    }
    if (!isSource(change.source)) {
      problems.push({
        path: `${path}/source`,
        code: "maintenance.trigger-source",
        message: "A trigger source must be a non-empty relative path or id with forward slashes and no `..` segment.",
      });
      return;
    }
    if (!(CHANGES as readonly string[]).includes(change.change)) {
      problems.push({
        path: `${path}/change`,
        code: "maintenance.trigger-change",
        message: "A trigger change must be `added`, `changed`, or `removed`.",
      });
      return;
    }
    if (change.change !== "removed" && (change.sha256 === undefined || !HASH.test(change.sha256))) {
      problems.push({
        path: `${path}/sha256`,
        code: "maintenance.trigger-hash",
        message: "An added or changed trigger needs the SHA-256 of its new content.",
      });
      return;
    }
    if (!HASH.test(snapshot.id) || snapshotIdOf(snapshot) !== snapshot.id) {
      problems.push({
        path: "/snapshot/id",
        code: "maintenance.trigger-snapshot",
        message: "A trigger needs the id derived from its four input hashes; recompute the snapshot.",
      });
      return;
    }

    const id = sha256(
      `mizzen-maintenance-trigger\0${canonicalJson({
        version: 1,
        kind: change.kind,
        source: change.source,
        change: change.change,
        sha256: change.sha256 ?? null,
        snapshot: snapshot.id,
      })}`,
    );
    if (byId.has(id)) {
      duplicates.push(id);
      return;
    }
    byId.set(id, {
      version: 1,
      id,
      kind: change.kind,
      source: change.source,
      change: change.change,
      detail: (change.detail ?? defaultDetail(change)).trim(),
      snapshot,
    });
  });

  const triggers = [...byId.values()].sort(
    (a, b) => byCodePoint(a.source, b.source) || byCodePoint(a.kind, b.kind) || byCodePoint(a.change, b.change),
  );
  return { triggers, duplicates: [...new Set(duplicates)].sort(byCodePoint), problems };
}

/** What registration needs besides the triggers. */
export interface TriggerRegisterOptions {
  /** Tasks already known; a matching key returns the existing task. */
  readonly existing?: readonly MaintenanceTask["task"][];
  /** The check an acceptance criterion names. Default `site`. */
  readonly check?: string;
  /** The budget for each task. */
  readonly budget?: TaskBudget;
}

/** The key a trigger always addresses, so a repeat can never open a second task. */
export function triggerKey(trigger: MaintenanceTrigger): string {
  return `maintenance:trigger:${trigger.id}`;
}

/** The scope a trigger names; a schema or file is a file, an API symbol a symbol, a record a collection. */
function scopeOf(trigger: MaintenanceTrigger) {
  if (trigger.kind === "api") return { pages: [], blocks: [], collections: [], symbols: [trigger.source], files: [] };
  if (trigger.kind === "data") {
    const collection = trigger.source.split("/")[0] ?? trigger.source;
    return { pages: [], blocks: [], collections: [collection], symbols: [], files: [] };
  }
  return { pages: [], blocks: [], collections: [], symbols: [], files: [trigger.source] };
}

/** The raw contract a trigger registers, exposed so a caller can show it before registering. */
export function triggerTaskInput(trigger: MaintenanceTrigger, options: TriggerRegisterOptions = {}): object {
  const check = options.check ?? "site";
  return {
    version: 1,
    idempotencyKey: triggerKey(trigger),
    goal: `Maintain documentation for ${trigger.source} after it was ${trigger.change === "removed" ? "removed" : "changed"}.`,
    scope: scopeOf(trigger),
    snapshot: trigger.snapshot,
    budget: options.budget ?? { contextTokens: 12000, toolCalls: 30, timeMs: 300_000 },
    permissions: { read: ["*"], write: ["maintenance"], check: ["maintenance"] },
    acceptance: [
      {
        id: "current",
        statement: `The documentation no longer contradicts ${trigger.source}: ${trigger.detail}`,
        check,
      },
    ],
  };
}

/**
 * Registers one task per trigger. Repeating a trigger returns its existing task with
 * `created: false`; the same trigger content can never produce two task documents.
 */
export function registerTriggerTasks(
  triggers: readonly MaintenanceTrigger[],
  options: TriggerRegisterOptions = {},
): MaintenanceTaskResult {
  const check = options.check ?? "site";
  const tasks: MaintenanceTask[] = [];
  const problems: TaskProblem[] = [];
  const known = [...(options.existing ?? [])];
  const seen = new Set<string>();

  for (const trigger of triggers) {
    const key = triggerKey(trigger);
    if (seen.has(key)) continue;
    seen.add(key);
    const result = registerTask(triggerTaskInput(trigger, options), {
      existing: known,
      checks: [check],
    });
    if (result.task === undefined) {
      problems.push(...result.problems);
      continue;
    }
    if (result.created) known.push(result.task);
    tasks.push({
      version: 1,
      id: trigger.id,
      trigger: `trigger:${trigger.id}`,
      created: result.created,
      task: result.task,
    });
  }

  return { tasks, skipped: [], problems };
}

/** The task id a trigger addresses, without registering it. */
export function triggerTaskId(trigger: MaintenanceTrigger): string {
  return taskIdOf(triggerKey(trigger));
}
