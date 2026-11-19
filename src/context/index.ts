/**
 * Task-aware context compilation: a task contract becomes a request, the graph selects entry points
 * and closes their dependencies, the sources become exact sourced fragments, and a fixed budget
 * decides what fits. See `compile.ts` for the whole pipeline and `types.ts` for the compiled form.
 */
export {
  ContextCompileError,
  compileTaskContext,
  contextJson,
  diffContextPacks,
  invalidatedContexts,
  refillContext,
  refreshContext,
} from "./compile.ts";
export type {
  CompileContextOptions,
  ContextCacheEntry,
  ContextChangeReason,
  ContextDiff,
  ContextDiffEntry,
  ContextRefill,
} from "./compile.ts";
export { changeTypeOf, requestForTask } from "./request.ts";
export type { CriterionEvidence, TaskRequestOptions, TaskRequestResult } from "./request.ts";
export {
  DEFAULT_CONTEXT_DEPTH,
  DEFAULT_CONTEXT_NODES,
  contextGraphOf,
  entryKindOf,
  resolveRef,
  selectFromGraph,
} from "./select.ts";
export type { ContextSelection, SelectOptions } from "./select.ts";
export { fragmentsOf, taskReferences } from "./sources.ts";
export { packContext, renderContext } from "./budget.ts";
export type { PackedContext } from "./budget.ts";
export type {
  CompiledContext,
  ContextAccounting,
  ContextAnswerability,
  ContextCache,
  ContextCriterionAnswer,
  ContextDependency,
  ContextEntry,
  ContextEntryKind,
  ContextFragment,
  ContextOmission,
  ContextOmissionReason,
  ContextReference,
  ContextRequestAction,
  ContextSourceMeta,
  TaskBlockReference,
} from "./types.ts";
