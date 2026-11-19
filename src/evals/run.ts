/**
 * Running one evaluation suite: parse every case, pin the environment, call the adapter, score the
 * result, and publish a versioned report.
 *
 * The runner is a seam. This module never imports a provider, a model SDK, or a network client; it
 * asks the adapter for an {@link EvalAgentOutput} and reads the fixture itself for the pins, the
 * compiled pack, and the edit target. A malformed case, a tool version that does not match the
 * suite's pin, or an adapter failure invalidates the affected case instead of scoring it.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  EvalAgentOutput,
  EvalBaselineComparison,
  EvalCase,
  EvalCaseResult,
  EvalComponents,
  EvalFinding,
  EvalMetrics,
  EvalReport,
  EvalRunOptions,
  EvalToolPin,
  EvalTotals,
} from "../contracts/evals.ts";
import {
  EVAL_REPORT_VERSION,
  EVAL_RUBRIC_VERSION,
  EVAL_RUBRIC_WEIGHTS,
} from "../contracts/evals.ts";
import { canonicalJson, sha256 } from "../data/lock.ts";
import { version } from "../index.ts";
import { compareBaseline } from "./baseline.ts";
import { readEvalCase, readEvalSuite } from "./case.ts";
import { evalGate } from "./gate.ts";
import { caseFacts, casePath, type CaseFacts } from "./pins.ts";
import { referenceRunner } from "./reference.ts";
import { scoreCase } from "./score.ts";
import type { EvalRunner } from "./runner.ts";

/** What {@link runEvalSuite} returns besides the report: parsed cases for callers that need them. */
export interface EvalRunResult {
  readonly report: EvalReport;
  readonly cases: readonly EvalCase[];
}

/** Zeroed components for a case that was not scored. */
const ZERO_COMPONENTS: EvalComponents = { success: 0, evidence: 0, scope: 0, checks: 0, efficiency: 0 };

/** Metrics for a case that was not run. */
function emptyMetrics(value: EvalCase): EvalMetrics {
  return {
    inputTokens: 0,
    outputTokens: 0,
    tokens: 0,
    toolCalls: 0,
    budgetTokens: value.budget.maxTokens,
    budgetToolCalls: value.budget.maxToolCalls,
    contextTokens: 0,
    contextPages: 0,
  };
}

/** The pins one case must match the runner's declared tools on. */
function casePinFindings(value: EvalCase, runner: EvalRunner): EvalFinding[] {
  const findings: EvalFinding[] = [];
  for (const pin of value.tools) {
    const provided = runner.tools.find((tool) => tool.name === pin.name);
    if (provided === undefined) {
      findings.push({
        code: "eval.pin-tool",
        message: `${value.id}: the runner provides no tool \`${pin.name}\`; the case pins ${pin.version}.`,
      });
    } else if (provided.version !== pin.version) {
      findings.push({
        code: "eval.pin-tool",
        message: `${value.id}: tool \`${pin.name}\` is version ${provided.version}, not the pinned ${pin.version}.`,
      });
    }
  }
  return findings;
}

/** The suite's environment pins checked against the adapter that is actually running. */
function suitePinFindings(suite: { mizzen?: string; package?: string; tools?: readonly EvalToolPin[] }, runner: EvalRunner, packagePin: string): EvalFinding[] {
  const findings: EvalFinding[] = [];
  if (suite.mizzen !== undefined && suite.mizzen !== version) {
    findings.push({
      code: "eval.pin-mizzen",
      message: `The suite pins Mizzen ${suite.mizzen}; this run is ${version}.`,
    });
  }
  if (suite.package !== undefined && suite.package !== packagePin) {
    findings.push({
      code: "eval.pin-package",
      message: `The suite pins package ${suite.package}; this run records ${packagePin}.`,
    });
  }
  for (const pin of suite.tools ?? []) {
    const provided = runner.tools.find((tool) => tool.name === pin.name);
    if (provided === undefined || provided.version !== pin.version) {
      findings.push({
        code: "eval.pin-tool",
        message: `The suite pins \`${pin.name}\` ${pin.version}; the runner reports ${provided?.version ?? "no version"}.`,
      });
    }
  }
  return findings;
}

/** Builds a result for a case that could not be scored. */
function unscored(
  value: EvalCase,
  runner: EvalRunner,
  facts: CaseFacts,
  status: "invalid" | "unavailable",
  findings: readonly EvalFinding[],
  unavailable?: string,
): EvalCaseResult {
  return {
    version: EVAL_REPORT_VERSION,
    id: value.id,
    title: value.title,
    capability: value.capability,
    status,
    snapshot: value.snapshot,
    pins: facts.pins,
    runner: { id: runner.id, version: runner.version, ...(runner.model === undefined ? {} : { model: runner.model }) },
    components: ZERO_COMPONENTS,
    weighted: 0,
    security: "ok",
    criteria: value.criteria.map((criterion) => ({ id: criterion.id, statement: criterion.statement, satisfied: false })),
    metrics: emptyMetrics(value),
    evidence: { pages: [], symbols: [], citations: [], refs: [], files: [], checks: [] },
    findings,
    ...(unavailable === undefined ? {} : { unavailable }),
  };
}

/** The report id: a hash over the suite, pins, adapter, and every scored case. */
function runId(content: {
  readonly suite: EvalReport["suite"];
  readonly pins: EvalReport["pins"];
  readonly runner: EvalReport["run"]["runner"];
  readonly cases: readonly EvalCaseResult[];
}): string {
  return sha256(`mizzen-eval-run\0${canonicalJson(content)}`);
}

/** Sums the case metrics into totals. */
function totalsOf(cases: readonly EvalCaseResult[]): EvalTotals {
  const scored = cases.filter((item) => item.status === "passed" || item.status === "failed");
  const weighted = scored.length === 0 ? 0 : Math.round((scored.reduce((total, item) => total + item.weighted, 0) / scored.length) * 1000) / 1000;
  return {
    cases: cases.length,
    passed: cases.filter((item) => item.status === "passed").length,
    failed: cases.filter((item) => item.status === "failed").length,
    invalid: cases.filter((item) => item.status === "invalid").length,
    unavailable: cases.filter((item) => item.status === "unavailable").length,
    weighted,
    metrics: {
      inputTokens: cases.reduce((total, item) => total + item.metrics.inputTokens, 0),
      outputTokens: cases.reduce((total, item) => total + item.metrics.outputTokens, 0),
      tokens: cases.reduce((total, item) => total + item.metrics.tokens, 0),
      toolCalls: cases.reduce((total, item) => total + item.metrics.toolCalls, 0),
    },
  };
}

/** Runs one suite. `suite` is the suite file or the folder holding `suite.json`. */
export async function runEvalSuite(options: EvalRunOptions, runner: EvalRunner = referenceRunner): Promise<EvalRunResult> {
  const suiteFile = options.suite.endsWith(".json") ? options.suite : join(options.suite, "suite.json");
  const suiteRoot = dirname(suiteFile);
  const suiteRead = await readEvalSuite(suiteFile);
  if (suiteRead.suite === undefined) {
    throw new Error(suiteRead.problems.map((problem) => `${problem.path || "/"}: ${problem.message}`).join("\n"));
  }
  const suite = suiteRead.suite;
  const packagePin = options.package ?? "source";
  const cases: EvalCase[] = [];
  for (const path of suite.cases) {
    const read = await readEvalCase(casePath(suiteRoot, path));
    if (read.case === undefined) {
      throw new Error(read.problems.map((problem) => `${path}${problem.path}: ${problem.message}`).join("\n"));
    }
    cases.push(read.case);
  }

  const globalPins = {
    mizzen: version,
    package: packagePin,
    ...(options.build === undefined ? {} : { build: options.build }),
    tools: [...runner.tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  };
  const pinFindings = suitePinFindings(suite.pins, runner, packagePin);
  const results: EvalCaseResult[] = [];
  const sites = new Map<string, NonNullable<CaseFacts["site"]>>();

  for (const value of cases) {
    const fixtureRoot = casePath(suiteRoot, value.fixture);
    let facts: CaseFacts;
    try {
      facts = await caseFacts(value, suiteRoot, sites.get(fixtureRoot));
    } catch (error) {
      facts = {
        pins: { fixture: "missing", config: "missing", pack: "none", agent: "none" },
        problems: [{ path: "", code: "eval.fixture", message: error instanceof Error ? error.message : String(error) }],
      };
    }
    if (facts.site !== undefined) sites.set(fixtureRoot, facts.site);

    const pins = [...pinFindings, ...casePinFindings(value, runner), ...facts.problems.map((problem) => ({ code: problem.code, message: problem.message }))];
    if (value.unavailable !== undefined && pins.length === 0) {
      results.push(unscored(value, runner, facts, "unavailable", [], value.unavailable));
      continue;
    }
    if (pins.length > 0) {
      results.push(unscored(value, runner, facts, "invalid", pins));
      continue;
    }

    let output: EvalAgentOutput;
    try {
      output = await runner.run({ case: value, fixtureRoot, suiteRoot });
    } catch (error) {
      results.push(
        unscored(value, runner, facts, "invalid", [
          { code: "eval.runner", message: `${value.id}: the runner failed: ${error instanceof Error ? error.message : String(error)}` },
        ]),
      );
      continue;
    }

    try {
      const scored = await scoreCase({ case: value, output, facts, fixtureRoot, suiteRoot });
      const passed = scored.security === "ok" && scored.criteria.every((criterion) => criterion.satisfied);
      results.push({
        version: EVAL_REPORT_VERSION,
        id: value.id,
        title: value.title,
        capability: value.capability,
        status: passed ? "passed" : "failed",
        snapshot: value.snapshot,
        pins: facts.pins,
        runner: { id: runner.id, version: runner.version, ...(runner.model === undefined ? {} : { model: runner.model }) },
        components: scored.components,
        weighted: scored.weighted,
        security: scored.security,
        criteria: scored.criteria,
        metrics: scored.metrics,
        evidence: scored.evidence,
        findings: scored.findings,
      });
    } catch (error) {
      results.push(
        unscored(value, runner, facts, "invalid", [
          { code: "eval.score", message: `${value.id}: scoring failed: ${error instanceof Error ? error.message : String(error)}` },
        ]),
      );
    }
  }

  const runnerPin = { id: runner.id, version: runner.version, ...(runner.model === undefined ? {} : { model: runner.model }) };
  const suiteRef = { id: suite.id, version: suite.version };
  const id = runId({ suite: suiteRef, pins: globalPins, runner: runnerPin, cases: results });
  const totals = totalsOf(results);
  const report: EvalReport = {
    version: EVAL_REPORT_VERSION,
    suite: suiteRef,
    run: { id, runner: runnerPin, package: packagePin },
    pins: globalPins,
    rubric: { version: EVAL_RUBRIC_VERSION, weights: EVAL_RUBRIC_WEIGHTS, critical: "security" },
    cases: results,
    totals,
    gate: evalGate(results),
  };

  const baseline = options.baseline;
  if (baseline === undefined) return { report, cases };
  const comparison: EvalBaselineComparison = compareBaseline(report, baseline);
  if (options.strictBaseline === true && !comparison.comparable) {
    throw new Error(`the baseline cannot be compared: ${comparison.reasons.join("; ")}`);
  }
  return { report: { ...report, baseline: comparison }, cases };
}

/** Reads a baseline JSON document, refusing malformed input with one sentence. */
export async function readEvalBaseline(file: string): Promise<import("../contracts/evals.ts").EvalBaseline> {
  const value = JSON.parse(await readFile(file, "utf8")) as import("../contracts/evals.ts").EvalBaseline;
  if (value.version !== 1 || !Array.isArray(value.cases) || value.pins === undefined) {
    throw new Error(`${file}: not a version 1 evaluation baseline`);
  }
  return value;
}
