/**
 * The subtask lease lifecycle (#1195) and recovery after owner loss (#1196).
 *
 * A lease names one owner, the scope that owner may write, the snapshot the work is pinned to, and
 * an expiry. Only the owner can renew it. Releasing it returns a receipt that says who released it
 * and when, so a later agent can audit the handover.
 *
 * An expired lease is not free by itself. A claimant must show that the owner has been quiet and
 * that the tree still matches the lease's snapshot. Any edit still present in the tree is reported
 * and preserved; this module never deletes or rewrites an edit to take a lease. Time is always the
 * caller's `nowMs`, so the same calls give the same decisions on every machine.
 */
import type { EditTransactionScope } from "../contracts/edit-transaction.ts";
import type {
  CoordinationActivity,
  CoordinationEdit,
  CoordinationLease,
  CoordinationLeaseReclaim,
  CoordinationLeaseResult,
  CoordinationReclaimResult,
  CoordinationRecoveryCheck,
  CoordinationState,
} from "../contracts/coordination.ts";
import type { TaskProblem } from "../contracts/task.ts";
import { sha256 } from "../data/lock.ts";

/** How long an owner must be quiet before a lease can be reclaimed. */
export const DEFAULT_RECLAIM_QUIET_MS = 5 * 60 * 1000;

/** What creating a lease needs. */
export interface CoordinationLeaseInput {
  readonly subtask: string;
  readonly owner: string;
  readonly scope: EditTransactionScope;
  readonly snapshot: string;
  readonly nowMs: number;
  readonly ttlMs: number;
  /** 0 for a new lease; a reclaim supplies the previous generation plus one. */
  readonly generation?: number;
}

/** What renewing a lease needs. */
export interface CoordinationRenewInput {
  readonly owner: string;
  readonly nowMs: number;
  readonly ttlMs: number;
}

/** What releasing a lease needs. */
export interface CoordinationReleaseInput {
  readonly owner: string;
  readonly nowMs: number;
  readonly reason: string;
}

/** What reclaiming an expired lease needs. */
export interface CoordinationReclaimInput {
  readonly lease: CoordinationLease;
  readonly claimant: string;
  readonly nowMs: number;
  readonly ttlMs: number;
  /** Work each agent did, in any order; the check sorts what it reports. */
  readonly activity: readonly CoordinationActivity[];
  /** The tree as it stands now. A changed snapshot refuses the reclaim. */
  readonly state: CoordinationState;
  /** Defaults to {@link DEFAULT_RECLAIM_QUIET_MS}. */
  readonly quietMs?: number;
}

/** The lease id: content, not a counter, so a renewal keeps it and a reclaim changes it. */
export function leaseIdOf(input: {
  readonly subtask: string;
  readonly owner: string;
  readonly snapshot: string;
  readonly generation: number;
}): string {
  return sha256(
    `mizzen-coordination-lease\0${input.subtask}\0${input.owner}\0${input.snapshot}\0${input.generation}`,
  );
}

/** True while the lease has time left; at exactly `expiresAt` it is expired. */
export function leaseIsActive(lease: CoordinationLease, nowMs: number): boolean {
  return nowMs < lease.expiresAt;
}

/** Creates a lease, or explains why the values cannot form one. */
export function createLease(input: CoordinationLeaseInput): CoordinationLeaseResult {
  const problems: TaskProblem[] = [];
  const owner = text(input.owner, "/lease/owner", problems, "the one agent that owns the work");
  const subtask = text(input.subtask, "/lease/subtask", problems, "a subtask id");
  const snapshot = text(input.snapshot, "/lease/snapshot", problems, "the snapshot id");
  const scope = scopeOf(input.scope, problems);
  const nowMs = time(input.nowMs, "/lease/nowMs", problems);
  const ttlMs = duration(input.ttlMs, "/lease/ttlMs", problems);
  const generation = generationOf(input.generation ?? 0, problems);
  if (problems.length > 0 || owner === undefined || subtask === undefined || snapshot === undefined || scope === undefined || nowMs === undefined || ttlMs === undefined || generation === undefined) {
    return { problems };
  }
  return {
    lease: {
      id: leaseIdOf({ subtask, owner, snapshot, generation }),
      subtask,
      owner,
      scope,
      snapshot,
      issuedAt: nowMs,
      expiresAt: nowMs + ttlMs,
      generation,
    },
    problems: [],
  };
}

/** Extends an active lease, but only for its owner. */
export function renewLease(
  lease: CoordinationLease,
  input: CoordinationRenewInput,
): CoordinationLeaseResult {
  const problems: TaskProblem[] = [];
  const owner = text(input.owner, "/lease/owner", problems, "the lease owner");
  const nowMs = time(input.nowMs, "/lease/nowMs", problems);
  const ttlMs = duration(input.ttlMs, "/lease/ttlMs", problems);
  if (owner !== undefined && owner !== lease.owner) {
    problems.push({
      path: "/lease/owner",
      code: "coordination.lease-owner",
      message: `Lease ${lease.id} belongs to ${lease.owner}; ${owner} cannot renew it.`,
    });
  }
  if (nowMs !== undefined && !leaseIsActive(lease, nowMs)) {
    problems.push({
      path: "/lease/expiresAt",
      code: "coordination.lease-expired",
      message: `Lease ${lease.id} expired at ${lease.expiresAt}; renew before it expires or reclaim it after the checks.`,
    });
  }
  if (problems.length > 0 || nowMs === undefined || ttlMs === undefined) return { problems };
  return { lease: { ...lease, expiresAt: nowMs + ttlMs }, problems: [] };
}

/** Ends a lease and records the release receipt. The owner is the only one who may release it. */
export function releaseLease(
  lease: CoordinationLease,
  input: CoordinationReleaseInput,
): CoordinationLeaseResult {
  const problems: TaskProblem[] = [];
  const owner = text(input.owner, "/release/owner", problems, "the lease owner");
  const reason = text(input.reason, "/release/reason", problems, "why the lease is released");
  const nowMs = time(input.nowMs, "/release/nowMs", problems);
  if (owner !== undefined && owner !== lease.owner) {
    problems.push({
      path: "/release/owner",
      code: "coordination.release-owner",
      message: `Lease ${lease.id} belongs to ${lease.owner}; ${owner} cannot release it.`,
    });
  }
  if (problems.length > 0 || reason === undefined || nowMs === undefined) return { problems };
  return {
    release: {
      version: 1,
      lease: lease.id,
      subtask: lease.subtask,
      owner: lease.owner,
      releasedAt: nowMs,
      status: leaseIsActive(lease, nowMs) ? "released" : "expired",
      reason,
    },
    problems: [],
  };
}

/**
 * Reclaims an expired lease after checking the owner's recent activity, the current snapshot, and
 * any edit still in the tree. A failed check returns no lease and lists every preserved edit.
 */
export function reclaimLease(input: CoordinationReclaimInput): CoordinationReclaimResult {
  const { lease } = input;
  const problems: TaskProblem[] = [];
  const claimant = text(input.claimant, "/reclaim/claimant", problems, "the replacement agent id");
  const nowMs = time(input.nowMs, "/reclaim/nowMs", problems);
  const ttlMs = duration(input.ttlMs, "/reclaim/ttlMs", problems);
  const quietMs = input.quietMs === undefined ? DEFAULT_RECLAIM_QUIET_MS : duration(input.quietMs, "/reclaim/quietMs", problems, true);
  if (problems.length > 0 || claimant === undefined || nowMs === undefined || ttlMs === undefined || quietMs === undefined) {
    return { preserved: preservedEdits(input.activity, input.state), problems };
  }

  const expired = !leaseIsActive(lease, nowMs);
  const ownerActivity = input.activity
    .filter((row) => row.agent === lease.owner && row.at >= lease.issuedAt)
    .map((row) => row.at);
  const lastOwnerActivity = ownerActivity.length === 0 ? undefined : Math.max(...ownerActivity);
  const ownerQuiet = lastOwnerActivity === undefined || nowMs - lastOwnerActivity >= quietMs;
  const stateUnchanged = input.state.snapshot === lease.snapshot;
  const preserved = preservedEdits(input.activity, input.state);

  const checks: CoordinationRecoveryCheck[] = [
    {
      id: "expired",
      status: expired ? "passed" : "failed",
      detail: expired
        ? `Lease ${lease.id} expired at ${lease.expiresAt}.`
        : `Lease ${lease.id} is active until ${lease.expiresAt}.`,
    },
    {
      id: "owner-quiet",
      status: ownerQuiet ? "passed" : "failed",
      detail: ownerQuiet
        ? lastOwnerActivity === undefined
          ? `Owner ${lease.owner} recorded no activity.`
          : `Owner ${lease.owner} was last active at ${lastOwnerActivity}, at least ${quietMs} ms ago.`
        : `Owner ${lease.owner} was active at ${lastOwnerActivity}, within the ${quietMs} ms quiet window.`,
    },
    {
      id: "state-unchanged",
      status: stateUnchanged ? "passed" : "failed",
      detail: stateUnchanged
        ? `The tree is still at snapshot ${lease.snapshot}.`
        : `The tree is at snapshot ${input.state.snapshot}, not the lease's ${lease.snapshot}.`,
    },
    {
      id: "edits-preserved",
      status: preserved.length === 0 ? "passed" : "failed",
      detail: preserved.length === 0
        ? "No uncommitted edit is present in the tree."
        : `${preserved.length} edit(s) are still present (${preserved.map((edit) => edit.file).join(", ")}); they are kept and the lease is not taken.`,
    },
  ];

  const codes: Readonly<Record<CoordinationRecoveryCheck["id"], string>> = {
    expired: "coordination.lease-active",
    "owner-quiet": "coordination.owner-active",
    "state-unchanged": "coordination.state-changed",
    "edits-preserved": "coordination.edits-present",
  };
  for (const check of checks) {
    if (check.status === "passed") continue;
    problems.push({ path: "/reclaim", code: codes[check.id], message: check.detail });
  }
  if (problems.length > 0) return { preserved, problems };

  const generation = lease.generation + 1;
  const next: CoordinationLease = {
    id: leaseIdOf({ subtask: lease.subtask, owner: claimant, snapshot: lease.snapshot, generation }),
    subtask: lease.subtask,
    owner: claimant,
    scope: lease.scope,
    snapshot: lease.snapshot,
    issuedAt: nowMs,
    expiresAt: nowMs + ttlMs,
    generation,
  };
  const reclaim: CoordinationLeaseReclaim = {
    version: 1,
    lease: lease.id,
    subtask: lease.subtask,
    from: lease.owner,
    to: claimant,
    reclaimedAt: nowMs,
    snapshot: lease.snapshot,
    preserved: [],
    checks,
  };
  return { lease: next, reclaim, preserved: [], problems: [] };
}

/** Edits whose after-hash is still the current file hash, sorted so reports are stable. */
function preservedEdits(
  activity: readonly CoordinationActivity[],
  state: CoordinationState,
): readonly CoordinationEdit[] {
  const edits = activity.flatMap((row) => row.edits).filter(
    (edit) => edit.afterHash !== edit.beforeHash && state.files[edit.file] === edit.afterHash,
  );
  const seen = new Set<string>();
  return edits
    .filter((edit) => {
      const key = `${edit.file}\0${edit.beforeHash}\0${edit.afterHash}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(
      (a, b) =>
        compare(a.file, b.file) || compare(a.beforeHash, b.beforeHash) || compare(a.afterHash, b.afterHash),
    );
}

/** A trimmed non-empty owner, or `undefined`; `*` is never one agent. */
function text(
  value: string,
  path: string,
  problems: TaskProblem[],
  expected: string,
): string | undefined {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "*") {
    problems.push({
      path,
      code: "coordination.lease-value",
      message: `\`${path}\` must be ${expected}, not \`${trimmed}\`.`,
    });
    return undefined;
  }
  return trimmed;
}

/** A finite non-negative time. */
function time(value: number, path: string, problems: TaskProblem[]): number | undefined {
  if (!Number.isFinite(value) || value < 0) {
    problems.push({
      path,
      code: "coordination.lease-time",
      message: `\`${path}\` must be a non-negative millisecond time.`,
    });
    return undefined;
  }
  return value;
}

/** A positive duration; `zeroOk` allows the quiet window to be zero. */
function duration(
  value: number,
  path: string,
  problems: TaskProblem[],
  zeroOk = false,
): number | undefined {
  if (!Number.isFinite(value) || value < 0 || (!zeroOk && value === 0)) {
    problems.push({
      path,
      code: "coordination.lease-duration",
      message: `\`${path}\` must be ${zeroOk ? "a non-negative" : "a positive"} number of milliseconds.`,
    });
    return undefined;
  }
  return value;
}

/** A whole generation, zero or more. */
function generationOf(value: number, problems: TaskProblem[]): number | undefined {
  if (!Number.isInteger(value) || value < 0) {
    problems.push({
      path: "/lease/generation",
      code: "coordination.lease-generation",
      message: "`/lease/generation` must be a non-negative whole number.",
    });
    return undefined;
  }
  return value;
}

/** A scope with at least one reference. */
function scopeOf(scope: EditTransactionScope | undefined, problems: TaskProblem[]): EditTransactionScope | undefined {
  if (scope === undefined || typeof scope !== "object") {
    problems.push({
      path: "/lease/scope",
      code: "coordination.lease-scope",
      message: "`/lease/scope` must name at least one page, block, symbol, record, or file.",
    });
    return undefined;
  }
  if (scope.pages.length + scope.blocks.length + scope.symbols.length + scope.records.length + scope.files.length === 0) {
    problems.push({
      path: "/lease/scope",
      code: "coordination.lease-scope",
      message: "`/lease/scope` must name at least one page, block, symbol, record, or file.",
    });
    return undefined;
  }
  return scope;
}

/** Compares by code point. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
