/**
 * Hand a running subtask to a replacement agent (#1202).
 *
 * The replacement receives the checkpoint the previous agent stopped at, the lease transferred to
 * its own name, the context pack, the checks that ran, and the transactions already applied. The
 * handoff refuses a lease owned by someone else, an expired lease, a checkpoint for another
 * subtask or snapshot, and an empty pack. `acceptHandoff` returns the skip list, and
 * `shouldApplyHandoff` makes the no-repeat rule explicit: a transaction in `applied` is never
 * applied again.
 */
import type {
  CoordinationHandoff,
  CoordinationHandoffResult,
  CoordinationLease,
  CoordinationResume,
  CoordinationResumeResult,
} from "../contracts/coordination.ts";
import type { InteractionCheckpoint } from "../contracts/interaction.ts";
import type { InteractionCheck } from "../contracts/interaction.ts";
import type { TaskProblem } from "../contracts/task.ts";
import { leaseIdOf, leaseIsActive } from "./lease.ts";

/** What a handoff needs. */
export interface CoordinationHandoffInput {
  readonly lease: CoordinationLease;
  readonly from: string;
  readonly to: string;
  readonly checkpoint: InteractionCheckpoint;
  readonly pack: string;
  readonly checks: readonly InteractionCheck[];
  readonly nowMs: number;
  readonly ttlMs: number;
}

/** What accepting a handoff needs. */
export interface CoordinationAcceptInput {
  readonly owner: string;
  readonly nowMs: number;
}

/** Transfers a lease and everything the replacement needs to continue. */
export function handoffSubtask(input: CoordinationHandoffInput): CoordinationHandoffResult {
  const problems: TaskProblem[] = [];
  const from = principal(input.from, "/handoff/from", problems);
  const to = principal(input.to, "/handoff/to", problems);
  const pack = input.pack.trim();
  const nowMs = input.nowMs;
  const ttlMs = input.ttlMs;

  if (from !== undefined && from !== input.lease.owner) {
    problems.push({
      path: "/handoff/from",
      code: "coordination.handoff-owner",
      message: `Lease ${input.lease.id} belongs to ${input.lease.owner}; ${from} cannot hand it off.`,
    });
  }
  if (to !== undefined && to === from) {
    problems.push({
      path: "/handoff/to",
      code: "coordination.handoff-self",
      message: "A handoff needs a replacement agent, not the current owner.",
    });
  }
  if (!leaseIsActive(input.lease, nowMs)) {
    problems.push({
      path: "/handoff/lease",
      code: "coordination.handoff-expired",
      message: `Lease ${input.lease.id} expired at ${input.lease.expiresAt}; reclaim it before handing it off.`,
    });
  }
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    problems.push({
      path: "/handoff/ttlMs",
      code: "coordination.handoff-ttl",
      message: "`/handoff/ttlMs` must be a positive number of milliseconds.",
    });
  }
  if (pack === "") {
    problems.push({
      path: "/handoff/pack",
      code: "coordination.handoff-pack",
      message: "A handoff needs the replacement's context pack.",
    });
  }
  if (input.checkpoint.taskId !== input.lease.subtask) {
    problems.push({
      path: "/handoff/checkpoint/taskId",
      code: "coordination.handoff-checkpoint",
      message: `The checkpoint belongs to ${input.checkpoint.taskId}, not subtask ${input.lease.subtask}.`,
    });
  }
  if (input.checkpoint.snapshot !== input.lease.snapshot) {
    problems.push({
      path: "/handoff/checkpoint/snapshot",
      code: "coordination.handoff-snapshot",
      message: `The checkpoint is for snapshot ${input.checkpoint.snapshot}, not the lease's ${input.lease.snapshot}.`,
    });
  }
  if (problems.length > 0 || from === undefined || to === undefined) return { problems };

  const lease: CoordinationLease = {
    ...input.lease,
    id: leaseIdOf({
      subtask: input.lease.subtask,
      owner: to,
      snapshot: input.lease.snapshot,
      generation: input.lease.generation,
    }),
    owner: to,
    issuedAt: nowMs,
    expiresAt: nowMs + ttlMs,
  };
  return {
    handoff: {
      version: 1,
      subtask: input.lease.subtask,
      from,
      to,
      snapshot: input.lease.snapshot,
      lease,
      checkpoint: input.checkpoint,
      pack,
      checks: input.checks,
      applied: [...input.checkpoint.applied],
      status: input.checks.some((check) => check.status === "failed") ? "blocked" : "ready",
    },
    problems: [],
  };
}

/** Lets the replacement continue, with the transactions it must not repeat. */
export function acceptHandoff(
  handoff: CoordinationHandoff,
  input: CoordinationAcceptInput,
): CoordinationResumeResult {
  const problems: TaskProblem[] = [];
  const owner = principal(input.owner, "/resume/owner", problems);
  if (owner !== undefined && owner !== handoff.to) {
    problems.push({
      path: "/resume/owner",
      code: "coordination.resume-owner",
      message: `Handoff ${handoff.subtask} is for ${handoff.to}; ${owner} cannot accept it.`,
    });
  }
  if (!leaseIsActive(handoff.lease, input.nowMs)) {
    problems.push({
      path: "/resume/lease",
      code: "coordination.resume-expired",
      message: `The transferred lease expired at ${handoff.lease.expiresAt}; reclaim it before continuing.`,
    });
  }
  if (problems.length > 0) return { problems };

  const resume: CoordinationResume = {
    subtask: handoff.subtask,
    snapshot: handoff.snapshot,
    next: handoff.checkpoint.next,
    pack: handoff.pack,
    checks: handoff.checks,
    skip: [...handoff.applied],
    status: handoff.status,
  };
  return { resume, problems: [] };
}

/** False for a transaction the previous agent already applied. */
export function shouldApplyHandoff(handoff: CoordinationHandoff, transaction: string): boolean {
  return !handoff.applied.includes(transaction);
}

/** A trimmed non-empty principal id; `*` is never one agent. */
function principal(value: string, path: string, problems: TaskProblem[]): string | undefined {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "*") {
    problems.push({
      path,
      code: "coordination.handoff-principal",
      message: `\`${path}\` must name one agent, not \`${trimmed}\`.`,
    });
    return undefined;
  }
  return trimmed;
}
