/**
 * Recording and comparing a baseline.
 *
 * A baseline keeps the runner, the environment pins, and every case's status, weighted score,
 * components, metrics, and own pins. A later report is compared case by case: a lower score or a
 * pass that turned into a failure regresses, a higher score improves, and a case whose pins changed
 * is `incomparable` with the reason instead of being reported as a regression.
 */
import type {
  EvalBaseline,
  EvalBaselineCase,
  EvalBaselineComparison,
  EvalBaselineDelta,
  EvalReport,
} from "../contracts/evals.ts";
import { EVAL_BASELINE_VERSION } from "../contracts/evals.ts";

/** True when two tool lists name the same versions, whatever their order. */
function sameTools(a: readonly { name: string; version: string }[], b: readonly { name: string; version: string }[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  const right = [...b].sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  return left.every((tool, index) => tool.name === right[index]?.name && tool.version === right[index]?.version);
}

/** Records a report as a baseline. */
export function baselineOf(report: EvalReport): EvalBaseline {
  const cases: EvalBaselineCase[] = report.cases.map((item) => ({
    id: item.id,
    status: item.status,
    weighted: item.weighted,
    components: item.components,
    metrics: item.metrics,
    pins: item.pins,
  }));
  return {
    version: EVAL_BASELINE_VERSION,
    suite: { id: report.suite.id, version: report.suite.version },
    runner: report.run.runner,
    pins: report.pins,
    cases,
  };
}

/** The reason two runs cannot be compared, or `undefined` when every pin agrees. */
function environmentReason(report: EvalReport, baseline: EvalBaseline): string | undefined {
  if (report.suite.id !== baseline.suite.id || report.suite.version !== baseline.suite.version) {
    return `the baseline is for suite ${baseline.suite.id}@${baseline.suite.version}, not ${report.suite.id}@${report.suite.version}`;
  }
  if (report.pins.mizzen !== baseline.pins.mizzen) {
    return `Mizzen ${baseline.pins.mizzen} is not ${report.pins.mizzen}`;
  }
  if (report.pins.package !== baseline.pins.package) {
    return `package ${baseline.pins.package} is not ${report.pins.package}`;
  }
  if (!sameTools(report.pins.tools, baseline.pins.tools)) {
    return "the tool versions differ";
  }
  return undefined;
}

/** Compares a report with a baseline. */
export function compareBaseline(report: EvalReport, baseline: EvalBaseline): EvalBaselineComparison {
  const environment = environmentReason(report, baseline);
  const previous = new Map(baseline.cases.map((item) => [item.id, item]));
  const current = new Map(report.cases.map((item) => [item.id, item]));
  const deltas: EvalBaselineDelta[] = [];
  let comparableWeight = 0;
  let comparableCount = 0;
  let previousWeight = 0;

  for (const item of report.cases) {
    const before = previous.get(item.id);
    if (before === undefined) {
      deltas.push({
        id: item.id,
        status: "new",
        weighted: item.weighted,
        previous: 0,
        delta: item.weighted,
        tokens: item.metrics.tokens,
        previousTokens: 0,
        toolCalls: item.metrics.toolCalls,
        previousToolCalls: 0,
        ...(environment === undefined ? {} : { reason: environment }),
      });
      continue;
    }
    previous.delete(item.id);
    const pinChanges: string[] = [];
    if (before.pins.fixture !== item.pins.fixture) pinChanges.push("fixture");
    if (before.pins.config !== item.pins.config) pinChanges.push("config");
    if (before.pins.pack !== item.pins.pack) pinChanges.push("pack");
    if (before.pins.agent !== item.pins.agent) pinChanges.push("agent");
    const reason =
      environment ??
      (pinChanges.length > 0 ? `the ${pinChanges.join(", ")} pin changed` : undefined);
    if (reason !== undefined || item.status === "invalid" || before.status === "invalid" || item.status === "unavailable" || before.status === "unavailable") {
      deltas.push({
        id: item.id,
        status: "incomparable",
        weighted: item.weighted,
        previous: before.weighted,
        delta: Math.round((item.weighted - before.weighted) * 1000) / 1000,
        tokens: item.metrics.tokens,
        previousTokens: before.metrics.tokens,
        toolCalls: item.metrics.toolCalls,
        previousToolCalls: before.metrics.toolCalls,
        reason: reason ?? "one side is invalid or unavailable",
      });
      continue;
    }
    comparableCount += 1;
    comparableWeight += item.weighted;
    previousWeight += before.weighted;
    const delta = Math.round((item.weighted - before.weighted) * 1000) / 1000;
    const status =
      item.status === "failed" && before.status === "passed"
        ? "regressed"
        : item.status === "passed" && before.status === "failed"
          ? "improved"
          : delta < 0
            ? "regressed"
            : delta > 0
              ? "improved"
              : "unchanged";
    deltas.push({
      id: item.id,
      status,
      weighted: item.weighted,
      previous: before.weighted,
      delta,
      tokens: item.metrics.tokens,
      previousTokens: before.metrics.tokens,
      toolCalls: item.metrics.toolCalls,
      previousToolCalls: before.metrics.toolCalls,
    });
  }

  for (const [id, before] of previous) {
    deltas.push({
      id,
      status: "removed",
      weighted: 0,
      previous: before.weighted,
      delta: Math.round((0 - before.weighted) * 1000) / 1000,
      tokens: 0,
      previousTokens: before.metrics.tokens,
      toolCalls: 0,
      previousToolCalls: before.metrics.toolCalls,
      ...(environment === undefined ? {} : { reason: environment }),
    });
  }

  const regressed = deltas.filter((item) => item.status === "regressed").map((item) => item.id);
  const mean = (total: number): number => (comparableCount === 0 ? 0 : Math.round((total / comparableCount) * 1000) / 1000);
  return {
    comparable: environment === undefined,
    reasons: environment === undefined ? [] : [environment],
    cases: deltas,
    weighted: mean(comparableWeight),
    previous: mean(previousWeight),
    delta: Math.round((mean(comparableWeight) - mean(previousWeight)) * 1000) / 1000,
    regressed,
  };
}
