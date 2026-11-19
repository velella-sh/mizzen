/**
 * Cost accounting: context, refill, and tool calls per subtask, added up to one total.
 *
 * The numbers come from what the recorder stored on each event. A subtask that names none is
 * `unassigned`; rows keep first-appearance order. An event without a recorded tool-call count is one
 * call, so a trace written before costs were filled still reports a truthful call count. Time is
 * summed but never compared: it is a measurement, not a fact replay relies on.
 */
import type { TaskBudget, TaskBudgetStop, TaskUsage } from "../contracts/task.ts";
import type { TraceDocument, TraceProblem, TraceSubtaskCost, TraceUsage } from "../contracts/trace.ts";
import { budgetStops } from "../tasks/budget.ts";

/** One subtask's row, created on first sight. */
interface Row {
  readonly subtask: string;
  contextTokens: number;
  refillTokens: number;
  toolCalls: number;
}

/** Every subtask's spend, in first-appearance order, and the total. */
export function traceUsage(trace: TraceDocument): TraceUsage {
  const rows: Row[] = [];
  const byName = new Map<string, Row>();
  let timeMs = 0;

  for (const event of trace.events) {
    const name = event.subtask ?? "unassigned";
    let row = byName.get(name);
    if (row === undefined) {
      row = { subtask: name, contextTokens: 0, refillTokens: 0, toolCalls: 0 };
      byName.set(name, row);
      rows.push(row);
    }
    row.contextTokens += event.cost?.contextTokens ?? 0;
    row.refillTokens += event.cost?.refillTokens ?? 0;
    row.toolCalls += event.cost?.toolCalls ?? 1;
    timeMs += event.durationMs ?? 0;
  }

  const total = rows.reduce(
    (sum, row) => ({
      contextTokens: sum.contextTokens + row.contextTokens,
      refillTokens: sum.refillTokens + row.refillTokens,
      toolCalls: sum.toolCalls + row.toolCalls,
    }),
    { contextTokens: 0, refillTokens: 0, toolCalls: 0 },
  );
  const subtasks: TraceSubtaskCost[] = rows.map((row) => ({ ...row }));
  return { subtasks, total, timeMs, toolCalls: total.toolCalls };
}

/** True when the trace's totals are the usage a task report claims, for the two deterministic limits. */
export function usageProblems(trace: TraceDocument, usage: TaskUsage): readonly TraceProblem[] {
  const totals = traceUsage(trace).total;
  const problems: TraceProblem[] = [];
  if (totals.contextTokens + totals.refillTokens !== usage.contextTokens) {
    problems.push({
      path: "/events",
      code: "trace.cost-report",
      message: `The trace accounts for ${totals.contextTokens + totals.refillTokens} context tokens, but the report says ${usage.contextTokens}.`,
    });
  }
  if (totals.toolCalls !== usage.toolCalls) {
    problems.push({
      path: "/events",
      code: "trace.cost-report",
      message: `The trace accounts for ${totals.toolCalls} tool calls, but the report says ${usage.toolCalls}.`,
    });
  }
  return problems;
}

/** Every independent budget limit the trace's totals exceed, in the task budget's order. */
export function traceBudgetStops(trace: TraceDocument, budget: TaskBudget): readonly TaskBudgetStop[] {
  const totals = traceUsage(trace);
  return budgetStops(budget, {
    contextTokens: totals.total.contextTokens + totals.total.refillTokens,
    toolCalls: totals.total.toolCalls,
    timeMs: totals.timeMs,
  });
}
