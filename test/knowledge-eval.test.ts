/**
 * #1374: evaluate answers when the evidence is missing. The fixture page declares an explicit unknown, so a definitive
 * answer without evidence must fail, while an answer bounded to the evidence and citing the declaration must pass.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { EvalAgentOutput, EvalCase } from "../src/contracts/evals.ts";
import { readEvalCase } from "../src/evals/case.ts";
import { caseFacts } from "../src/evals/pins.ts";
import { scoreCase } from "../src/evals/score.ts";
import { knowledgeReportOf } from "../src/knowledge/report.ts";
import { buildModel } from "../src/model/build.ts";

const SUITE = fileURLToPath(new URL("../fixtures/evals", import.meta.url));
const FIXTURE = join(SUITE, "site");

/** Reads one shipped case. */
async function caseOf(id: string): Promise<EvalCase> {
  const read = await readEvalCase(join(SUITE, `cases/${id}.json`));
  assert.ok(read.case, JSON.stringify(read.problems));
  return read.case;
}

/** Scores one case with an edited output. */
async function score(id: string, output: EvalAgentOutput) {
  const value = await caseOf(id);
  const facts = await caseFacts(value, SUITE);
  return scoreCase({ case: value, output, facts, fixtureRoot: FIXTURE, suiteRoot: SUITE });
}

/** Whether every criterion is satisfied, the same rule `run.ts` uses for a case's status. */
function passes(scored: Awaited<ReturnType<typeof score>>): boolean {
  return scored.security === "ok" && scored.criteria.every((criterion) => criterion.satisfied);
}

test("#1374 the fixture gives the case an explicit unknown on Windows", async () => {
  const { site } = await buildModel(FIXTURE);
  const page = site.pages.find((candidate) => candidate.source.file === "guide/windows.md");
  assert.equal(page?.knowledge?.status, "unknown");
  assert.deepEqual(page?.knowledge?.scope, [{ kind: "platform", value: "windows" }]);
  const report = knowledgeReportOf(site);
  assert.ok(report.gaps.some((gap) => gap.subject.id === "guide/windows.md" && gap.kind === "unknown"));
});

test("#1374 a bounded answer that cites the unknown is accepted", async () => {
  const output = JSON.parse(readFileSync(join(SUITE, "agents/answer-bounded.json"), "utf8")) as EvalAgentOutput;
  const scored = await score("answer-bounded", output);
  assert.equal(scored.components.success, 1);
  assert.equal(scored.components.evidence, 1);
  assert.equal(passes(scored), true);
});

test("#1374 a definitive answer without evidence is rejected", async () => {
  const output = JSON.parse(readFileSync(join(SUITE, "agents/answer-bounded.json"), "utf8")) as EvalAgentOutput;
  // The agent asserts a firm answer and cites nothing: the case must fail on both counts.
  const definitive = {
    ...output,
    answer: { text: "Yes, the engine runs on Windows and is fully supported.", citations: [] },
  };
  const scored = await score("answer-bounded", definitive);
  assert.equal(scored.components.evidence, 0);
  assert.equal(passes(scored), false);
  assert.ok(scored.findings.some((finding) => finding.code === "eval.answer-wrong"));
  assert.ok(scored.findings.some((finding) => finding.code === "eval.citation-missing"));
});

test("#1374 a definitive answer that cites the wrong page is rejected", async () => {
  const output = JSON.parse(readFileSync(join(SUITE, "agents/answer-bounded.json"), "utf8")) as EvalAgentOutput;
  const wrong = {
    ...output,
    answer: { text: "Yes, Windows is supported.", citations: ["guide/deploy.md:9"] },
  };
  const scored = await score("answer-bounded", wrong);
  assert.equal(scored.components.evidence, 0, "a forbidden source drops evidence to zero");
  assert.equal(passes(scored), false);
  assert.ok(scored.findings.some((finding) => finding.code === "eval.answer-forbidden"));
});
