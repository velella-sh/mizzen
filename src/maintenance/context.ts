/**
 * Compile the context one maintenance task needs (#1233).
 *
 * The changed sources, affected pages, evidence, and required checks come from the task contract;
 * `../context` selects and packs the exact fragments within the task's token budget. Every input
 * that did not fit is named with its reason before any model runs, so a caller can ask for more
 * evidence instead of guessing.
 */
import type { Site } from "../contracts/content.ts";
import type { TaskContract } from "../contracts/task.ts";
import type { ContextAccounting, ContextAnswerability, ContextOmission } from "../context/types.ts";
import type { CompiledContext } from "../context/types.ts";
import { compileTaskContext, type CompileContextOptions } from "../context/compile.ts";

/** What one maintenance context pack exposes besides the compiled pack. */
export interface MaintenanceContext {
  readonly version: 1;
  readonly task: string;
  readonly snapshot: string;
  /** Files the drift changed, from the task scope. */
  readonly changedSources: readonly string[];
  /** Pages the drift affects, from the task scope. */
  readonly affectedPages: readonly string[];
  /** The checks the acceptance criteria require. */
  readonly requiredChecks: readonly string[];
  readonly omissions: readonly ContextOmission[];
  readonly accounting: ContextAccounting;
  readonly answerability: ContextAnswerability;
  readonly markdown: string;
  /** The full compiled pack, for a caller that needs fragments, entries, or lineage. */
  readonly compiled: CompiledContext;
}

/**
 * Compiles a maintenance task's context. The task must be a valid request; an invalid one throws
 * `ContextCompileError` before any content is read. A budget too small to hold every fragment is
 * not an error: the pack stays inside the budget and `omissions` explains the gap.
 */
export async function compileMaintenanceContext(
  site: Site,
  task: TaskContract,
  options: CompileContextOptions = {},
): Promise<MaintenanceContext> {
  const compiled = await compileTaskContext(site, task, options);
  return {
    version: 1,
    task: task.idempotencyKey,
    snapshot: task.snapshot.id,
    changedSources: [...task.scope.files],
    affectedPages: [...task.scope.pages],
    requiredChecks: [...new Set(task.acceptance.flatMap((criterion) => (criterion.check === undefined ? [] : [criterion.check])))],
    omissions: [...compiled.omitted],
    accounting: compiled.accounting,
    answerability: compiled.answerability,
    markdown: compiled.markdown,
    compiled,
  };
}
