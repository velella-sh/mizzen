/** The task contract and lifecycle surface: parsing, identities, snapshots, registration, moves, migration, and discovery. */
export { parseTaskContract, TASK_CONTRACT_VERSION, type TaskParseOptions } from "./contract.ts";
export { requestIdOf, taskIdOf } from "./identity.ts";
export { snapshotChanged, snapshotIdOf, taskSnapshot, type TaskInputHashes, type TaskSnapshotInput } from "./snapshot.ts";
export { registerTask, type TaskRegistrationOptions, type TaskRegistrationResult } from "./register.ts";
export {
  emptyScope,
  SCOPE_KINDS,
  scopeIsEmpty,
  scopeReferences,
  validateScopeReferences,
  type TaskReferenceIndex,
  type TaskScopeKind,
} from "./scope.ts";
export { acceptanceOutcomes, criterionOutcome, type TaskCriterionResult } from "./acceptance.ts";
export { budgetStops, withinBudget } from "./budget.ts";
export {
  allowedTransitions,
  canCheck,
  canRead,
  canTransition,
  canWrite,
  cancelTask,
  expireTask,
  replayTask,
  TASK_ACTIVE_STATUSES,
  TASK_STATUSES,
  TASK_TERMINAL_STATUSES,
  TASK_TRANSITIONS,
  transitionTask,
  type TaskReplayResult,
  type TaskTransitionRequest,
  type TaskTransitionResult,
} from "./lifecycle.ts";
export {
  migrateTaskDocument,
  migrateTaskFile,
  TASK_DOCUMENT_VERSION,
  type TaskMigrateFileOptions,
  type TaskMigrateFileResult,
  type TaskMigrateOptions,
  type TaskMigrateResult,
} from "./migrate.ts";
export { relatedTasks } from "./related.ts";
