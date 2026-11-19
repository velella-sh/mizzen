/** The coordination surface: split, ownership, leases, scheduling, evidence, merge, escalation, handoff, and budget. */
export { byCodePoint, orderSubtasks, type CoordinationNode, type CoordinationOrderResult } from "./graph.ts";
export { coordinationParentOf, splitSubtasks, subtaskIdOf } from "./split.ts";
export { checkStart, overlappingOwnership, ownershipOf } from "./ownership.ts";
export {
  createLease,
  DEFAULT_RECLAIM_QUIET_MS,
  leaseIdOf,
  leaseIsActive,
  reclaimLease,
  releaseLease,
  renewLease,
  type CoordinationLeaseInput,
  type CoordinationReclaimInput,
  type CoordinationReleaseInput,
  type CoordinationRenewInput,
} from "./lease.ts";
export { scheduleSubtasks } from "./schedule.ts";
export { decideDuplicate, duplicateSubtasks } from "./duplicate.ts";
export { aggregateEvidence, type CoordinationAggregateInput } from "./evidence.ts";
export { conflictingFiles, mergeSubtaskResults } from "./merge.ts";
export { escalateMerge, resolveEscalation, type CoordinationEscalationInput } from "./escalate.ts";
export {
  acceptHandoff,
  handoffSubtask,
  shouldApplyHandoff,
  type CoordinationAcceptInput,
  type CoordinationHandoffInput,
} from "./handoff.ts";
export { reconcileBudget, sharedBudgetReport } from "./budget.ts";
export { runTwoAgentDemo, type TwoAgentDemo } from "./demo.ts";
