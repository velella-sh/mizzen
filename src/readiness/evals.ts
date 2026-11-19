import { readFile } from "node:fs/promises";
import type { ReadinessEvaluation } from "../contracts/readiness.ts";
import { RUBRIC } from "./rubric.ts";

/** One evaluation report as this adapter reads it. */
export interface EvaluationReport {
  /** Suite name; must equal the rubric's suite. */
  readonly suite: string;
  /** Suite version; must equal the rubric's version. */
  readonly version: string;
  /** The build hash the results were produced from. */
  readonly snapshot: string;
  /** `pass` or `fail` per readiness rule code. */
  readonly results: Readonly<Record<string, "pass" | "fail">>;
}

/** What reading an evaluation file produced: a report, or one reason it cannot be trusted. */
export type EvaluationRead =
  | { readonly evaluation: ReadinessEvaluation }
  | { readonly problem: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates an evaluation report. The suite and version must match the rubric, the snapshot must be a SHA-256, and
 * every result must be `pass` or `fail`; nothing else is guessed into a score.
 */
export function parseEvaluationReport(value: unknown): EvaluationRead {
  if (!isRecord(value)) return { problem: "the evaluation report is not a JSON object" };
  const { suite, version, snapshot, results } = value;
  if (typeof suite !== "string" || suite === "") return { problem: "the evaluation report has no suite" };
  if (typeof version !== "string" || version === "") return { problem: "the evaluation report has no version" };
  if (typeof snapshot !== "string" || !/^[0-9a-f]{64}$/.test(snapshot)) {
    return { problem: "the evaluation report's snapshot is not a build SHA-256" };
  }
  if (!isRecord(results)) return { problem: "the evaluation report has no results object" };
  if (suite !== RUBRIC.evaluation.suite) {
    return { problem: `suite "${suite}" is not "${RUBRIC.evaluation.suite}"` };
  }
  if (version !== RUBRIC.evaluation.version) {
    return { problem: `suite version "${version}" is not "${RUBRIC.evaluation.version}"` };
  }
  const parsed: Record<string, "pass" | "fail"> = {};
  for (const code of Object.keys(results).sort()) {
    const result = results[code];
    if (result !== "pass" && result !== "fail") {
      return { problem: `result for "${code}" is neither pass nor fail` };
    }
    parsed[code] = result;
  }
  return { evaluation: { suite, version, snapshot, results: parsed } };
}

/** Reads and validates an evaluation report from disk; a missing file is a reason, not a crash. */
export async function readEvaluationReport(path: string): Promise<EvaluationRead> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { problem: code === "ENOENT" ? `${path} does not exist` : `${path} is unreadable` };
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return { problem: `${path} is not valid JSON` };
  }
  return parseEvaluationReport(value);
}
