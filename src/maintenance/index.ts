/**
 * Reviewable automated maintenance (#1229-#1241): triggers, drift-derived tasks, the decision
 * between a deterministic fix and an agent, constrained scope, budgeted context, external patches,
 * previews, independent verification, stale-patch stops, pull-request recipes, no-op detection, and
 * the failure state that preserves the last good inputs.
 *
 * Every function is deterministic and local. Patches apply to text in memory, a recipe is data, and
 * no function here reads the network, calls a model, or merges a pull request.
 */
export {
  maintenanceChanges,
  maintenanceTriggers,
  registerTriggerTasks,
  triggerKey,
  triggerTaskId,
  triggerTaskInput,
  type TriggerRegisterOptions,
} from "./trigger.ts";
export {
  constrainMaintenanceScope,
  decideMaintenance,
  deterministicFixes,
  proposeMaintenanceTasks,
  proposalIdOf,
  type ProposeOptions,
} from "./propose.ts";
export { compileMaintenanceContext, type MaintenanceContext } from "./context.ts";
export {
  applyMaintenancePatch,
  closeNoopTask,
  deterministicMaintenancePatch,
  maintenanceNoop,
  markStalePatch,
  noopEvidenceId,
  parseMaintenancePatch,
  patchMessage,
  safePatchPath,
  staleMaintenancePatch,
  type AppliedMaintenanceFile,
  type AppliedMaintenancePatch,
  type PatchValidateOptions,
} from "./patch.ts";
export { checkKindOf, previewMaintenance, type PreviewOptions } from "./preview.ts";
export { DEFAULT_MAINTENANCE_CHECKS, verifyMaintenance, type VerifyOptions } from "./verify.ts";
export {
  maintenanceBranch,
  maintenanceRecipe,
  planMaintenancePullRequest,
  type RecipeOptions,
} from "./recipe.ts";
export {
  MAINTENANCE_STATE_FILE,
  maintenanceFailureReport,
  maintenanceStateAt,
  maintenanceStateText,
  readMaintenanceState,
  recordMaintenanceFailure,
  retryMaintenance,
  writeMaintenanceState,
  type MaintenanceRetry,
} from "./state.ts";
