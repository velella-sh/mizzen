import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { EvalAgentOutput, EvalCase } from "../src/contracts/evals.ts";
import { readEvalCase } from "../src/evals/case.ts";
import { caseFacts } from "../src/evals/pins.ts";
import { scoreCase } from "../src/evals/score.ts";

const SUITE = fileURLToPath(new URL("../fixtures/evals", import.meta.url));
const FIXTURE = join(SUITE, "site");

/** Reads one shipped case. */
async function caseOf(id: string): Promise<EvalCase> {
  const read = await readEvalCase(join(SUITE, `cases/${id}.json`));
  assert.ok(read.case, JSON.stringify(read.problems));
  return read.case;
}

/** Reads one recorded agent output. */
function outputOf(name: string): EvalAgentOutput {
  return JSON.parse(readFileSync(join(SUITE, `agents/${name}.json`), "utf8")) as EvalAgentOutput;
}

/** Scores one case with a recorded or edited output. */
async function score(id: string, output: EvalAgentOutput) {
  const value = await caseOf(id);
  const facts = await caseFacts(value, SUITE);
  return scoreCase({ case: value, output, facts, fixtureRoot: FIXTURE, suiteRoot: SUITE });
}

test("a correct answer without its precise citation does not pass", async () => {
  const output = outputOf("answer");
  const scored = await score("answer", { ...output, answer: { text: "Mizzen requires Node 24.", citations: [] } });
  assert.equal(scored.components.success, 1);
  assert.equal(scored.components.evidence, 0);
  assert.equal(scored.criteria[1]?.satisfied, false);
  assert.ok(scored.findings.some((finding) => finding.code === "eval.citation-missing"));
});

test("a forbidden source drops evidence to zero", async () => {
  const output = outputOf("answer");
  const scored = await score("answer", { ...output, answer: { text: "Mizzen requires Node 24.", citations: ["guide/deploy.md:9"] } });
  assert.equal(scored.components.evidence, 0);
  assert.ok(scored.findings.some((finding) => finding.code === "eval.answer-forbidden"));
});

test("the right diff at the wrong span does not pass", async () => {
  const output = outputOf("edit");
  const edit = output.edits![0]!;
  const shifted = { ...output, edits: [{ ...edit, span: { ...edit.span, column: 18, endColumn: 24 } }] };
  const scored = await score("edit", shifted);
  assert.equal(scored.components.success, 0);
  assert.equal(scored.components.scope, 1);
  assert.ok(scored.findings.some((finding) => finding.code === "eval.edit-wrong"));
});

test("an allowed denied read is a security violation, not a high score", async () => {
  const output = outputOf("permission");
  const attempts = output.permission!.attempts.map((attempt) =>
    attempt.target === "/guide/install/"
      ? { capability: "read" as const, target: attempt.target, resource: { kind: "page" as const, id: attempt.target, page: attempt.target } }
      : attempt,
  );
  const scored = await score("permission", { ...output, permission: { attempts } });
  assert.equal(scored.security, "violation");
  assert.equal(scored.components.success, 0);
  assert.ok(scored.criteria.every((criterion) => !criterion.satisfied));
  assert.ok(scored.findings.some((finding) => finding.code === "eval.permission-allowed"));
});

test("usage that disagrees with the trace cannot pass", async () => {
  const output = outputOf("answer");
  const scored = await score("answer", { ...output, trace: { toolCalls: 4, inputTokens: 1, outputTokens: 1 } });
  assert.equal(scored.components.checks, 0);
  assert.equal(scored.components.efficiency, 0);
  assert.ok(scored.criteria.every((criterion) => !criterion.satisfied));
  assert.ok(scored.findings.some((finding) => finding.code === "eval.trace-mismatch"));
});

test("a fabricated verification success is rejected by the independent verifier", async () => {
  const value = await caseOf("verification-fabricated");
  const facts = await caseFacts(value, SUITE);
  const scored = await scoreCase({
    case: value,
    output: { pages: [], symbols: [], toolCalls: [{ name: "verification", version: "1", ok: true }], usage: { inputTokens: 1, outputTokens: 1 }, trace: { toolCalls: 1, inputTokens: 1, outputTokens: 1 } },
    facts,
    fixtureRoot: FIXTURE,
    suiteRoot: SUITE,
  });
  assert.equal(scored.components.success, 1);
  assert.equal(scored.evidence.verifier?.ok, false);
  assert.equal(scored.evidence.verifier?.verdict, "incomplete");
  assert.ok((scored.evidence.verifier?.failures.length ?? 0) > 0);
});
