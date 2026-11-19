/** The agent-evaluation surface: case and suite parsing, deterministic runs, scoring, baselines, and the CI gate. */
export {
  parseEvalCase,
  parseEvalSuite,
  readEvalCase,
  readEvalSuite,
} from "./case.ts";
export { baselineOf, compareBaseline } from "./baseline.ts";
export { evalGate } from "./gate.ts";
export { caseFacts, evalTask, hashText, hashTree, type CaseFacts } from "./pins.ts";
export { referenceRunner } from "./reference.ts";
export { runEvalSuite, readEvalBaseline, type EvalRunResult } from "./run.ts";
export { scoreCase, weightedScore, type ScoreInput, type Scored } from "./score.ts";
export type { EvalRunner, EvalRunnerInput } from "./runner.ts";
export {
  EVAL_BASELINE_VERSION,
  EVAL_CASE_VERSION,
  EVAL_REPORT_VERSION,
  EVAL_RUBRIC_VERSION,
  EVAL_RUBRIC_WEIGHTS,
} from "../contracts/evals.ts";
export type {
  EvalAccessAttempt,
  EvalAgentOutput,
  EvalBaseline,
  EvalBaselineCase,
  EvalBaselineComparison,
  EvalBaselineDelta,
  EvalBudget,
  EvalCapability,
  EvalCase,
  EvalCaseEvidence,
  EvalCaseInputs,
  EvalCaseParseResult,
  EvalCasePins,
  EvalCaseResult,
  EvalCaseStatus,
  EvalComponent,
  EvalComponents,
  EvalCriterion,
  EvalCriterionResult,
  EvalEdit,
  EvalExpectation,
  EvalFinding,
  EvalGate,
  EvalMetrics,
  EvalPermissions,
  EvalProblem,
  EvalReport,
  EvalRubric,
  EvalRunOptions,
  EvalRunPins,
  EvalSpan,
  EvalSuite,
  EvalSuiteParseResult,
  EvalSuitePins,
  EvalToolCall,
  EvalToolPin,
  EvalTotals,
  EvalTraceTotals,
  EvalTransactionOutput,
  EvalUsage,
  EvalVerificationOutput,
} from "../contracts/evals.ts";
