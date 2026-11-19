/**
 * Account every subtask against the parent's shared budget (#1203).
 *
 * The report adds each subtask's tokens, tool calls, and time, then applies the parent's three
 * independent limits. `reconcileBudget` compares that report with the trace's own accounting, so a
 * final budget claim cannot disagree with the events that produced it. Rows are sorted by subtask
 * id, so the report bytes do not depend on the order the agents finished.
 */
import type { CoordinationBudgetReport, CoordinationPlan, CoordinationUsageRow } from "../contracts/coordination.ts";
import type { TaskProblem, TaskUsage } from "../contracts/task.ts";
import type { TraceUsage } from "../contracts/trace.ts";
import { budgetStops } from "../tasks/budget.ts";
import { byCodePoint } from "./graph.ts";

/** Adds every subtask's usage and applies the parent's limits. */
export function sharedBudgetReport(
  plan: CoordinationPlan,
  rows: readonly CoordinationUsageRow[],
): CoordinationBudgetReport {
  const ordered = [...rows]
    .map((row) => ({ subtask: row.subtask, usage: { ...row.usage } }))
    .sort((a, b) => byCodePoint(a.subtask, b.subtask));
  const total = ordered.reduce<TaskUsage>(
    (sum, row) => ({
      contextTokens: sum.contextTokens + row.usage.contextTokens,
      toolCalls: sum.toolCalls + row.usage.toolCalls,
      timeMs: sum.timeMs + row.usage.timeMs,
    }),
    { contextTokens: 0, toolCalls: 0, timeMs: 0 },
  );
  const stops = budgetStops(plan.parent.budget, total);
  return {
    version: 1,
    parent: plan.parent.id,
    budget: plan.parent.budget,
    rows: ordered,
    total,
    stops,
    within: stops.length === 0,
  };
}

/** Every disagreement between the final report and the trace, or an empty list. */
export function reconcileBudget(
  report: CoordinationBudgetReport,
  trace: TraceUsage,
): readonly TaskProblem[] {
  const problems: TaskProblem[] = [];
  const total = {
    contextTokens: trace.total.contextTokens + trace.total.refillTokens,
    toolCalls: trace.total.toolCalls,
    timeMs: trace.timeMs,
  };
  compare("/total/contextTokens", "contextTokens", report.total.contextTokens, total.contextTokens, "the trace accounts for", problems);
  compare("/total/toolCalls", "toolCalls", report.total.toolCalls, total.toolCalls, "the trace accounts for", problems);
  compare("/total/timeMs", "timeMs", report.total.timeMs, total.timeMs, "the trace accounts for", problems);

  const traceRows = new Map(trace.subtasks.map((row) => [row.subtask, row] as const));
  for (const row of report.rows) {
    const traced = traceRows.get(row.subtask);
    if (traced === undefined) {
      problems.push({
        path: `/rows/${row.subtask}`,
        code: "coordination.budget-trace",
        message: `The budget report names subtask ${row.subtask}, but the trace recorded no cost for it.`,
      });
      continue;
    }
    compare(`/rows/${row.subtask}/contextTokens`, "contextTokens", row.usage.contextTokens, traced.contextTokens + traced.refillTokens, `the trace accounts for ${row.subtask}`, problems);
    compare(`/rows/${row.subtask}/toolCalls`, "toolCalls", row.usage.toolCalls, traced.toolCalls, `the trace accounts for ${row.subtask}`, problems);
    traceRows.delete(row.subtask);
  }
  for (const subtask of [...traceRows.keys()].sort(byCodePoint)) {
    problems.push({
      path: `/trace/${subtask}`,
      code: "coordination.budget-trace",
      message: `The trace recorded cost for ${subtask}, but the budget report does not account for it.`,
    });
  }
  return problems.sort((a, b) => byCodePoint(a.path, b.path));
}

/** One value the report and the trace disagree on. */
function compare(
  path: string,
  field: string,
  reported: number,
  traced: number,
  source: string,
  problems: TaskProblem[],
): void {
  if (reported === traced) return;
  problems.push({
    path,
    code: "coordination.budget-total",
    message: `The report says ${reported} for ${field}, but ${source} ${traced}.`,
  });
}
