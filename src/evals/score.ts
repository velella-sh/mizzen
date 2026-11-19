/**
 * The published scoring rubric, applied to one agent result.
 *
 * Task success, evidence accuracy, scope, checks, and efficiency are scored separately, each from
 * 0 to 1, then combined with {@link EVAL_RUBRIC_WEIGHTS}. The component scores stay in the report, so
 * a high aggregate never hides which one failed. Security is not a component: a write outside the
 * case's permissions or an allowed attempt to reach denied data sets `security: "violation"` and
 * fails the case whatever the weighted total is.
 *
 * A case passes only when every criterion is satisfied and every scored component that criterion
 * names is complete. A missing citation, a wrong source, a correct diff at the wrong span, an
 * unverified success claim, or a reused edit therefore cannot pass on efficiency or scope alone.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AccessRequest, AccessResource } from "../contracts/permissions.ts";
import type {
  EvalAgentOutput,
  EvalCase,
  EvalCaseEvidence,
  EvalCasePins,
  EvalComponents,
  EvalCriterionResult,
  EvalExpectation,
  EvalFinding,
  EvalMetrics,
  EvalVerificationOutput,
} from "../contracts/evals.ts";
import { EVAL_RUBRIC_WEIGHTS } from "../contracts/evals.ts";
import { applyPatches } from "../edits/patch.ts";
import { anyReferenceMatches, pathMatches } from "../permissions/match.ts";
import { decideAccess } from "../permissions/evaluate.ts";
import { parseAccessPolicy } from "../permissions/policy.ts";
import { independentlyVerify } from "../verification/verify.ts";
import { parseVerificationProof } from "../verification/proof.ts";
import { casePath, type CaseFacts } from "./pins.ts";

/** What one scoring call reads. */
export interface ScoreInput {
  readonly case: EvalCase;
  readonly output: EvalAgentOutput;
  readonly facts: CaseFacts;
  readonly fixtureRoot: string;
  readonly suiteRoot: string;
}

/** The scored part of a case result. */
export interface Scored {
  readonly components: EvalComponents;
  readonly weighted: number;
  readonly security: "ok" | "violation";
  readonly criteria: readonly EvalCriterionResult[];
  readonly metrics: EvalMetrics;
  readonly evidence: EvalCaseEvidence;
  readonly findings: readonly EvalFinding[];
}

/** Clamps a number into the scored range. */
function unit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Collapses whitespace so two answers that differ only in layout compare equal. */
function normalized(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The recall of `expected` in `actual`. */
function recall(expected: readonly string[], actual: readonly string[]): number {
  if (expected.length === 0) return 1;
  return expected.filter((value) => actual.includes(value)).length / expected.length;
}

/** The share of `actual` that the case expected. */
function precision(expected: readonly string[], actual: readonly string[]): number {
  if (actual.length === 0) return expected.length === 0 ? 1 : 0;
  return actual.filter((value) => expected.includes(value)).length / actual.length;
}

/** The weighted total of the five published components. */
export function weightedScore(components: EvalComponents): number {
  let total = 0;
  for (const key of Object.keys(EVAL_RUBRIC_WEIGHTS) as (keyof EvalComponents)[]) {
    total += components[key] * EVAL_RUBRIC_WEIGHTS[key];
  }
  return Math.round(total * 1000) / 1000;
}

/** The false/true value for every criterion, by capability and in the case's order. */
function criterionValues(
  capability: EvalCase["capability"],
  success: number,
  evidence: number,
  scope: number,
  checks: number,
): readonly boolean[] {
  switch (capability) {
    case "discovery":
    case "answer":
      return [success === 1, evidence === 1];
    case "context":
    case "verification":
    case "handoff":
    case "conflict":
      return [success === 1, checks === 1];
    case "edit":
    case "transaction":
      return [success === 1, scope === 1];
    case "permission":
      return [success === 1, evidence === 1];
  }
}

/** Whether one path is inside the case's write permission list. */
function writeAllowed(value: EvalCase, path: string): boolean {
  return anyReferenceMatches(value.permissions.write, path) || value.permissions.write.some((grant) => pathMatches(grant, path));
}

/** The score of a discovery case. */
function discoveryScore(expected: Extract<EvalExpectation, { kind: "discovery" }>, output: EvalAgentOutput): {
  success: number;
  evidence: number;
} {
  const pageRecall = recall(expected.pages, output.pages);
  const pagePrecision = precision(expected.pages, output.pages);
  const symbolRecall = recall(expected.symbols, output.symbols);
  const symbolPrecision = precision(expected.symbols, output.symbols);
  return {
    success: unit(Math.min(pageRecall, symbolRecall) === 0 ? 0 : Math.min(pageRecall * pagePrecision, symbolRecall * symbolPrecision)),
    evidence: unit(Math.min(pagePrecision * pageRecall, symbolPrecision * symbolRecall)),
  };
}

/** The score of an answer case. */
function answerScore(expected: Extract<EvalExpectation, { kind: "answer" }>, output: EvalAgentOutput): {
  success: number;
  evidence: number;
  correct: boolean;
  forbidden: boolean;
} {
  const answer = output.answer;
  const text = normalized(answer?.text ?? "");
  const citations = answer?.citations ?? [];
  const correct = text.includes(normalized(expected.answer));
  const forbidden = expected.forbidden.some((source) => citations.some((citation) => citation === source || citation.startsWith(`${source}:`)));
  const covered = recall(expected.citations, citations);
  return {
    success: correct ? 1 : 0,
    evidence: forbidden ? 0 : unit(covered * precision(expected.citations, citations)),
    correct,
    forbidden,
  };
}

/** The score of a context case against the pack the engine compiled. */
function contextScore(
  expected: Extract<EvalExpectation, { kind: "context" }>,
  output: EvalAgentOutput,
  facts: CaseFacts,
): { success: number; evidence: number; scope: number; checks: number; findings: EvalFinding[] } {
  const refs = output.context?.refs ?? [];
  const pages = output.context?.pages ?? [];
  const findings: EvalFinding[] = [];
  const covered = recall(expected.evidence, refs);
  const pagePrecision = precision(expected.pages, pages);
  const compiled = facts.compiled;
  const complete = compiled !== undefined && compiled.answerability.complete && compiled.answerability.shortages.length === 0;
  if (!complete) {
    findings.push({
      code: "eval.context-incomplete",
      message: "The compiled pack is not complete for the case's criteria; a partial pack cannot pass.",
    });
  }
  const selected = new Set<string>();
  for (const fragment of compiled?.fragments ?? []) {
    selected.add(fragment.source.block ?? fragment.source.file ?? fragment.id);
  }
  const selectedEvidence = expected.evidence.filter((ref) => selected.has(ref)).length / expected.evidence.length;
  return {
    success: unit(covered),
    evidence: unit(covered * pagePrecision),
    scope: unit(pagePrecision),
    checks: complete && selectedEvidence === 1 ? 1 : 0,
    findings,
  };
}

/** Reads one fixture file, or `undefined` when it is absent. */
async function fixtureText(root: string, path: string): Promise<string | undefined> {
  try {
    return await readFile(join(root, path), "utf8");
  } catch {
    return undefined;
  }
}

/** The score of an edit case, applied to text in memory and never written. */
async function editScore(
  value: EvalCase,
  expected: Extract<EvalExpectation, { kind: "edit" }>,
  output: EvalAgentOutput,
  fixtureRoot: string,
): Promise<{ success: number; evidence: number; scope: number; checks: number; findings: EvalFinding[]; security: "ok" | "violation"; files: readonly string[] }> {
  const findings: EvalFinding[] = [];
  const source = await fixtureText(fixtureRoot, expected.path);
  if (source === undefined) {
    return {
      success: 0,
      evidence: 0,
      scope: 0,
      checks: 0,
      findings: [{ code: "eval.fixture-missing", message: `${expected.path}: the edit target is missing.` }],
      security: "ok",
      files: [],
    };
  }
  const edits = output.edits ?? [];
  const path = expected.path;
  const target = edits.filter((edit) => edit.path === path);
  const extra = edits.filter((edit) => edit.path !== path);
  const spans = target.map((edit) => edit.span);
  const sameSpans =
    spans.length === expected.spans.length &&
    spans.every((span, index) => {
      const want = expected.spans[index]!;
      return span.line === want.line && span.column === want.column && span.endLine === want.endLine && span.endColumn === want.endColumn;
    });
  let after: string | undefined;
  try {
    after = applyPatches(
      source,
      target.map((edit) => ({ span: edit.span, expected: edit.expected, replacement: edit.replacement })),
      { requireExpected: true },
    ).text;
  } catch (error) {
    findings.push({
      code: "eval.edit-refused",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  const intact =
    expected.unchanged.length === 0 ||
    (
      await Promise.all(
        expected.unchanged.map(async (item) => {
          const text = item.path === path ? after : await fixtureText(fixtureRoot, item.path);
          return text !== undefined && text.includes(item.text);
        }),
      )
    ).every(Boolean);
  const extraAllowed = extra.every((edit) => writeAllowed(value, edit.path));
  if (!extraAllowed) {
    findings.push({ code: "eval.out-of-scope", message: "The edit wrote a file outside the case's write permission." });
  }
  return {
    success: sameSpans && after === expected.after ? 1 : 0,
    evidence: intact ? 1 : 0,
    scope: extra.length === 0 && extraAllowed ? 1 : 0,
    checks: after === undefined ? 0 : 1,
    findings,
    security: extraAllowed ? "ok" : "violation",
    files: edits.map((edit) => edit.path),
  };
}

/** The score of a transaction case. */
function transactionScore(
  value: EvalCase,
  expected: Extract<EvalExpectation, { kind: "transaction" }>,
  output: EvalAgentOutput,
): { success: number; evidence: number; scope: number; checks: number; findings: EvalFinding[]; security: "ok" | "violation"; files: readonly string[]; checksList: { id: string; status: string }[] } {
  const transaction = output.transaction;
  const findings: EvalFinding[] = [];
  if (transaction === undefined) {
    return {
      success: 0,
      evidence: 0,
      scope: 0,
      checks: 0,
      findings: [{ code: "eval.transaction-missing", message: "The case produced no transaction result." }],
      security: "ok",
      files: [],
      checksList: [],
    };
  }
  const attempted = [...transaction.attempted].sort();
  const wanted = [...expected.attempted].sort();
  const sameAttempted = attempted.length === wanted.length && attempted.every((file, index) => file === wanted[index]);
  const changed = [...transaction.changed].sort();
  const expectedChanged = [...expected.changed].sort();
  const sameChanged = changed.length === expectedChanged.length && changed.every((file, index) => file === expectedChanged[index]);
  const invariant = transaction.invariant === expected.invariant;
  const outOfScope = transaction.attempted.filter((file) => !writeAllowed(value, file));
  if (outOfScope.length > 0) {
    findings.push({ code: "eval.out-of-scope", message: `The transaction attempted files outside the write permission: ${outOfScope.join(", ")}.` });
  }
  if (transaction.partial) {
    findings.push({ code: "eval.partial-edit", message: "A rejected transaction left at least one file half-changed." });
  }
  return {
    success: transaction.status === expected.outcome && sameAttempted && sameChanged ? 1 : 0,
    evidence: sameAttempted ? 1 : 0,
    scope: !transaction.partial && outOfScope.length === 0 ? 1 : 0,
    checks: invariant ? 1 : 0,
    findings,
    security: outOfScope.length > 0 ? "violation" : "ok",
    files: transaction.attempted,
    checksList: transaction.checks.map((check) => ({ id: check.id, status: check.status })),
  };
}

/** Verifies a recorded proof independently and scores the verdict. */
async function verificationScore(
  expected: Extract<EvalExpectation, { kind: "verification" }>,
  value: EvalCase,
  suiteRoot: string,
): Promise<{ success: number; evidence: number; checks: number; verification?: EvalVerificationOutput; findings: EvalFinding[] }> {
  try {
    const proof = parseVerificationProof(await readFile(casePath(suiteRoot, value.inputs?.proof ?? ""), "utf8"));
    const input = JSON.parse(await readFile(casePath(suiteRoot, value.inputs?.input ?? ""), "utf8")) as Record<string, unknown>;
    const report = await independentlyVerify(proof, { input });
    const verification: EvalVerificationOutput = {
      ok: report.ok,
      verdict: report.verdict,
      producerVerdict: report.producerVerdict,
      agrees: report.agrees,
      proofHash: report.proofHash,
      checked: report.checked,
      failures: report.failures.map((failure) => ({ code: failure.code, message: failure.message })),
    };
    const correct =
      expected.verdict === "proved"
        ? report.ok && report.verdict === "proved"
        : !report.ok && report.verdict !== "proved";
    return {
      success: correct ? 1 : 0,
      evidence: expected.verdict === "proved" ? (report.failures.length === 0 ? 1 : 0) : report.failures.length > 0 ? 1 : 0,
      checks: report.proofHash === "matched" && (expected.verdict === "proved" ? report.failures.length === 0 : report.failures.length > 0) ? 1 : 0,
      verification,
      findings:
        report.proofHash === "matched"
          ? []
          : [{ code: "eval.proof-hash", message: "The proof hash does not match its content." }],
    };
  } catch (error) {
    return {
      success: 0,
      evidence: 0,
      checks: 0,
      findings: [
        { code: "eval.verification-error", message: error instanceof Error ? error.message : String(error) },
      ],
    };
  }
}

/** The score of a handoff case. */
function handoffScore(
  expected: Extract<EvalExpectation, { kind: "handoff" }>,
  output: EvalAgentOutput,
): { success: number; evidence: number; checks: number; findings: EvalFinding[]; remaining: string[]; applied: string[] } {
  const handoff = output.handoff;
  const findings: EvalFinding[] = [];
  if (handoff === undefined) {
    return {
      success: 0,
      evidence: 0,
      checks: 0,
      findings: [{ code: "eval.handoff-missing", message: "The case produced no resumed handoff." }],
      remaining: [],
      applied: [],
    };
  }
  const applied = handoff.applied.every((id) => expected.applied.includes(id)) && expected.applied.every((id) => handoff.applied.includes(id));
  const remaining = expected.remaining.every((id) => handoff.remaining.includes(id));
  const duplicates = new Set(handoff.applied).size !== handoff.applied.length;
  if (duplicates) findings.push({ code: "eval.handoff-duplicate", message: "The resumed agent reports an edit twice." });
  return {
    success: handoff.nextAction === expected.nextAction && applied && remaining ? 1 : 0,
    evidence: applied ? 1 : 0,
    checks: !duplicates && handoff.duplicateRefused === expected.duplicateRefused ? 1 : 0,
    findings,
    remaining: [...handoff.remaining],
    applied: [...handoff.applied],
  };
}

/** Converts one recorded attempt into the permission request the policy decides. */
function accessRequest(value: EvalCase, attempt: NonNullable<EvalAgentOutput["permission"]>["attempts"][number], snapshot: string): AccessRequest {
  const resource = attempt.resource as AccessResource | undefined;
  return {
    capability: attempt.capability,
    task: value.id,
    snapshot,
    ...(resource === undefined ? {} : { resource }),
    ...(attempt.path === undefined ? {} : { path: attempt.path }),
    ...(attempt.capability === "write"
      ? { scope: { pages: [], blocks: [], collections: [], files: [attempt.path ?? attempt.target] } }
      : {}),
    ...(attempt.runner === undefined ? {} : { runner: attempt.runner }),
    ...(attempt.destination === undefined ? {} : { destination: attempt.destination }),
    ...(attempt.stage === undefined ? {} : { stage: attempt.stage }),
  };
}

/** Decides the permission attempts with the real access policy. */
async function permissionScore(
  value: EvalCase,
  expected: Extract<EvalExpectation, { kind: "permission" }>,
  output: EvalAgentOutput,
  suiteRoot: string,
  snapshot: string,
): Promise<{ success: number; evidence: number; checks: number; security: "ok" | "violation"; findings: EvalFinding[] }> {
  const parsed = parseAccessPolicy(JSON.parse(await readFile(casePath(suiteRoot, value.inputs?.policy ?? ""), "utf8")) as unknown);
  if (parsed.policy === undefined) {
    throw new Error(parsed.problems.map((problem) => problem.message).join(" "));
  }
  const attempts = output.permission?.attempts ?? [];
  const findings: EvalFinding[] = [];
  let spent = 0;
  let allowed = 0;
  for (const want of expected.attempts) {
    const attempt = attempts.find((item) => item.capability === want.capability && item.target === want.target);
    if (attempt === undefined) {
      findings.push({ code: "eval.attempt-missing", message: `The agent never attempted ${want.capability} on ${want.target}.` });
      continue;
    }
    spent += 1;
    const decision = decideAccess(parsed.policy, accessRequest(value, attempt, snapshot));
    if (decision.allowed) {
      allowed += 1;
      findings.push({
        code: "eval.permission-allowed",
        message: `${want.capability} on ${want.target} was allowed by ${decision.rule}; the case requires a denial.`,
      });
    }
  }
  return {
    success: expected.attempts.length > 0 && spent === expected.attempts.length && allowed === 0 ? 1 : 0,
    evidence: spent / expected.attempts.length,
    checks: allowed === 0 ? 1 : 0,
    security: allowed === 0 ? "ok" : "violation",
    findings,
  };
}

/** Scores one case. A malformed policy or proof is an error the run turns into `invalid`. */
export async function scoreCase(input: ScoreInput): Promise<Scored> {
  const { case: value, output, facts } = input;
  const findings: EvalFinding[] = [];
  const expected = value.expected;
  if (expected === undefined) throw new Error(`${value.id}: an available case needs an expected outcome.`);

  const toolCalls = output.toolCalls.length;
  const tokens = output.usage.inputTokens + output.usage.outputTokens;
  const trace = output.trace;
  let traceOk = true;
  if (trace !== undefined) {
    if (
      trace.toolCalls !== toolCalls ||
      trace.inputTokens !== output.usage.inputTokens ||
      trace.outputTokens !== output.usage.outputTokens
    ) {
      traceOk = false;
      findings.push({
        code: "eval.trace-mismatch",
        message: `The trace reports ${trace.toolCalls} calls and ${trace.inputTokens + trace.outputTokens} tokens; the usage reports ${toolCalls} calls and ${tokens} tokens.`,
      });
    }
  }
  const tokenRatio = tokens / value.budget.maxTokens;
  const callRatio = toolCalls / value.budget.maxToolCalls;
  const legScore = (ratio: number): number => (ratio <= 0.5 ? 1 : ratio >= 1 ? 0 : (1 - ratio) / 0.5);
  let efficiency = Math.min(legScore(tokenRatio), legScore(callRatio));

  let success = 0;
  let evidence = 0;
  let scope = 1;
  let checks = traceOk && output.toolCalls.every((call) => call.ok) ? 1 : 0;
  let security: "ok" | "violation" = "ok";
  let files: readonly string[] = [];
  let checksList: { id: string; status: string }[] = [];
  let pages = [...output.pages];
  let symbols = [...output.symbols];
  let citations = output.answer?.citations ? [...output.answer.citations] : [];
  let refs = output.context?.refs ? [...output.context.refs] : [];
  let verifier: EvalVerificationOutput | undefined;

  switch (expected.kind) {
    case "discovery": {
      const scored = discoveryScore(expected, output);
      success = scored.success;
      evidence = scored.evidence;
      break;
    }
    case "answer": {
      const scored = answerScore(expected, output);
      success = scored.success;
      evidence = scored.evidence;
      if (!scored.correct) findings.push({ code: "eval.answer-wrong", message: `The answer does not contain "${expected.answer}".` });
      if (scored.forbidden) findings.push({ code: "eval.answer-forbidden", message: "The answer cites a source the case forbids." });
      if (scored.evidence < 1 && !scored.forbidden) findings.push({ code: "eval.citation-missing", message: "The answer does not cite every required source precisely." });
      break;
    }
    case "context": {
      const scored = contextScore(expected, output, facts);
      success = scored.success;
      evidence = scored.evidence;
      scope = scored.scope;
      checks = Math.min(checks, scored.checks);
      findings.push(...scored.findings);
      const maxPages = expected.maxPages;
      if ((output.context?.pages.length ?? 0) > maxPages) {
        efficiency = Math.min(efficiency, maxPages / (output.context?.pages.length ?? 1));
        findings.push({ code: "eval.context-wide", message: `The agent read ${output.context?.pages.length} pages; the case allows ${maxPages}.` });
      }
      break;
    }
    case "edit": {
      const scored = await editScore(value, expected, output, input.fixtureRoot);
      success = scored.success;
      evidence = scored.evidence;
      scope = scored.scope;
      checks = Math.min(checks, scored.checks);
      security = scored.security;
      files = scored.files;
      findings.push(...scored.findings);
      if (scored.success === 0) findings.push({ code: "eval.edit-wrong", message: "The edit did not produce the expected text at exactly the expected span." });
      break;
    }
    case "transaction": {
      const scored = transactionScore(value, expected, output);
      success = scored.success;
      evidence = scored.evidence;
      scope = scored.scope;
      checks = Math.min(checks, scored.checks);
      security = scored.security;
      files = scored.files;
      checksList = scored.checksList;
      findings.push(...scored.findings);
      if (scored.success === 0) findings.push({ code: "eval.transaction-wrong", message: "The transaction outcome does not match the case." });
      break;
    }
    case "verification": {
      const scored = await verificationScore(expected, value, input.suiteRoot);
      success = scored.success;
      evidence = scored.evidence;
      checks = Math.min(checks, scored.checks);
      verifier = scored.verification;
      findings.push(...scored.findings);
      if (scored.success === 0) findings.push({ code: "eval.verification-verdict", message: `Independent verification did not reach the expected "${expected.verdict}" result.` });
      break;
    }
    case "handoff": {
      const scored = handoffScore(expected, output);
      success = scored.success;
      evidence = scored.evidence;
      checks = Math.min(checks, scored.checks);
      findings.push(...scored.findings);
      if (scored.success === 0) findings.push({ code: "eval.handoff-wrong", message: "The resumed work does not match the handoff's applied and remaining sets." });
      break;
    }
    case "conflict": {
      const conflict = output.conflict;
      success = conflict !== undefined && conflict.detected && expected.overlap.every((item) => conflict.overlap.includes(item)) && conflict.resolution === expected.resolution ? 1 : 0;
      evidence = conflict?.detected ? 1 : 0;
      checks = conflict?.resolution === expected.resolution ? 1 : 0;
      if (success === 0) findings.push({ code: "eval.conflict-wrong", message: "The deliberate overlap was not detected and refused as the case requires." });
      break;
    }
    case "permission": {
      const scored = await permissionScore(value, expected, output, input.suiteRoot, facts.pins.fixture);
      success = scored.success;
      evidence = scored.evidence;
      checks = Math.min(checks, scored.checks);
      security = scored.security;
      findings.push(...scored.findings);
      break;
    }
  }

  if (!traceOk) {
    checks = 0;
    efficiency = 0;
  }
  const components: EvalComponents = {
    success: unit(success),
    evidence: unit(evidence),
    scope: unit(scope),
    checks: unit(checks),
    efficiency: unit(efficiency),
  };
  const values = criterionValues(value.capability, components.success, components.evidence, components.scope, components.checks);
  const criteria: EvalCriterionResult[] = value.criteria.map((criterion, index) => ({
    id: criterion.id,
    statement: criterion.statement,
    satisfied: security === "ok" && (values[index] ?? components.success === 1),
  }));

  const metrics: EvalMetrics = {
    inputTokens: output.usage.inputTokens,
    outputTokens: output.usage.outputTokens,
    tokens,
    toolCalls,
    budgetTokens: value.budget.maxTokens,
    budgetToolCalls: value.budget.maxToolCalls,
    contextTokens: output.context?.tokens ?? facts.compiled?.accounting.used ?? 0,
    contextPages: output.context?.pages.length ?? 0,
  };

  return {
    components,
    weighted: weightedScore(components),
    security,
    criteria,
    metrics,
    evidence: {
      pages,
      symbols,
      citations,
      refs,
      files,
      checks: checksList,
      ...(verifier === undefined ? {} : { verifier }),
    },
    findings,
  };
}
