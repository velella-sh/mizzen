/**
 * The cost and budget report of one run, without a clock and without a model's usage report.
 *
 * Context tokens are the compiled pack's own estimate, not a vendor's count. Time is estimated from
 * those tokens at a documented planning rate; it is never measured, so two runs of the same task
 * report the same number. Tool calls count the context compile, the only tool this CLI ran. The
 * budget report keeps every exceeded limit with its own reason and gives each limit's remaining room.
 */
import type { TaskBudget, TaskBudgetStop, TaskUsage } from "../contracts/task.ts";
import { budgetStops } from "../tasks/budget.ts";

/** The cost document version. */
export const COST_VERSION = 1;

/** Planning rate: estimated context tokens an agent reads in one second. */
export const TOKENS_PER_SECOND = 50_000;

/** The deterministic estimate of how long reading a context pack takes. */
export function estimatedTimeMs(contextTokens: number): number {
  return Math.ceil((contextTokens * 1000) / TOKENS_PER_SECOND);
}

/** The machine-readable cost of one run. */
export interface AgentCost {
  readonly version: 1;
  readonly estimated: true;
  readonly contextTokens: number;
  readonly timeMs: number;
  readonly toolCalls: number;
  readonly method: string;
}

/** The cost report: the pack's tokens, the estimated read time, and the tool calls made. */
export function costOf(contextTokens: number, toolCalls: number): AgentCost {
  return {
    version: COST_VERSION,
    estimated: true,
    contextTokens,
    timeMs: estimatedTimeMs(contextTokens),
    toolCalls,
    method: `the context pack's token estimate; time at ${TOKENS_PER_SECOND} estimated tokens per second; one tool call per context compile`,
  };
}

/** What one run spent and what room each limit has left. */
export interface AgentBudgetReport {
  readonly limits: TaskBudget;
  readonly usage: TaskUsage;
  readonly remaining: TaskBudget;
  readonly stops: readonly TaskBudgetStop[];
}

/** The budget report, with every exceeded limit in the budget module's fixed order. */
export function budgetReportOf(budget: TaskBudget, usage: TaskUsage): AgentBudgetReport {
  return {
    limits: budget,
    usage,
    remaining: {
      contextTokens: Math.max(0, budget.contextTokens - usage.contextTokens),
      toolCalls: Math.max(0, budget.toolCalls - usage.toolCalls),
      timeMs: Math.max(0, budget.timeMs - usage.timeMs),
    },
    stops: budgetStops(budget, usage),
  };
}
