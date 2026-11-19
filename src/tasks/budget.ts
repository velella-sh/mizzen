/**
 * Budget stop conditions: context tokens, tool calls, and time are independent limits.
 *
 * Exceeding one limit never stands in for another: each returns its own status and a sentence that
 * names the spent and allowed values. The checks run in one fixed order, so a run that exceeds two
 * limits reports them in the same order every time. A value equal to its limit is within budget;
 * only spending more than the limit stops the task.
 */
import type { TaskBudget, TaskBudgetStop, TaskUsage } from "../contracts/task.ts";

/** Every exceeded limit, in the fixed order context tokens, tool calls, time. Empty means within. */
export function budgetStops(
  budget: TaskBudget,
  usage: TaskUsage,
): readonly TaskBudgetStop[] {
  const stops: TaskBudgetStop[] = [];
  if (usage.contextTokens > budget.contextTokens) {
    stops.push({
      status: "context-tokens-exceeded",
      reason: `Context tokens spent (${usage.contextTokens}) exceed the limit (${budget.contextTokens}).`,
    });
  }
  if (usage.toolCalls > budget.toolCalls) {
    stops.push({
      status: "tool-calls-exceeded",
      reason: `Tool calls made (${usage.toolCalls}) exceed the limit (${budget.toolCalls}).`,
    });
  }
  if (usage.timeMs > budget.timeMs) {
    stops.push({
      status: "time-exceeded",
      reason: `Time spent (${usage.timeMs} ms) exceeds the limit (${budget.timeMs} ms).`,
    });
  }
  return stops;
}

/** True when every limit still has room. */
export function withinBudget(budget: TaskBudget, usage: TaskUsage): boolean {
  return budgetStops(budget, usage).length === 0;
}
