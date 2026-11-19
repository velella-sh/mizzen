import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseEvalCase, parseEvalSuite, readEvalCase } from "../src/evals/case.ts";

const SUITE = fileURLToPath(new URL("../fixtures/evals", import.meta.url));

/** A valid case, with the fields a test overrides. */
function validCase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    id: "answer.example",
    title: "Answer an example",
    capability: "answer",
    goal: "Answer the question.",
    fixture: "site",
    snapshot: "site@1",
    permissions: { read: ["*"], write: [], check: [] },
    budget: { maxTokens: 100, maxToolCalls: 2 },
    criteria: [{ id: "answer", statement: "The answer is right." }],
    tools: [{ name: "context", version: "1" }],
    inputs: { agent: "agents/answer.json" },
    expected: { kind: "answer", answer: "Node 24", citations: ["guide/install.md:9"], forbidden: [] },
    ...overrides,
  };
}

test("a valid case parses and every shipped case validates", async () => {
  const parsed = parseEvalCase(validCase());
  assert.deepEqual(parsed.problems, []);
  assert.equal(parsed.case?.id, "answer.example");

  for (const file of readFileSync(join(SUITE, "suite.json"), "utf8") && (JSON.parse(readFileSync(join(SUITE, "suite.json"), "utf8")) as { cases: string[] }).cases) {
    const read = await readEvalCase(join(SUITE, file));
    assert.deepEqual(read.problems, [], file);
    assert.ok(read.case, file);
  }
});

test("a missing field names the JSON Pointer and what to write", () => {
  const { goal: _goal, ...withoutGoal } = validCase();
  const parsed = parseEvalCase(withoutGoal);
  assert.ok(parsed.problems.some((problem) => problem.path === "" && problem.code === "eval.missing-field" && problem.message.includes("`goal`")));
});

test("the capability must match the expectation and inputs must be present", () => {
  const mismatch = parseEvalCase(validCase({ capability: "discovery" }));
  assert.ok(mismatch.problems.some((problem) => problem.code === "eval.capability-mismatch"));

  const missingAgent = parseEvalCase(validCase({ inputs: {} }));
  assert.ok(missingAgent.problems.some((problem) => problem.path === "/inputs/agent"));

  const missingPolicy = parseEvalCase(validCase({
    capability: "permission",
    inputs: { agent: "agents/permission.json" },
    expected: { kind: "permission", attempts: [{ capability: "read", target: "/secret/" }] },
  }));
  assert.ok(missingPolicy.problems.some((problem) => problem.path === "/inputs/policy"));
});

test("duplicate ids, tool names, and escaping paths are refused", () => {
  const duplicated = parseEvalCase(validCase({
    criteria: [
      { id: "same", statement: "First." },
      { id: "same", statement: "Second." },
    ],
    tools: [
      { name: "context", version: "1" },
      { name: "context", version: "2" },
    ],
  }));
  assert.ok(duplicated.problems.some((problem) => problem.code === "eval.duplicate" && problem.path === "/criteria/1"));
  assert.ok(duplicated.problems.some((problem) => problem.code === "eval.duplicate" && problem.path === "/tools/1"));

  const escaping = parseEvalCase(validCase({ fixture: "../outside" }));
  assert.ok(escaping.problems.some((problem) => problem.code === "eval.relative-path" && problem.path === "/fixture"));
});

test("an unavailable case needs a reason and no expected outcome", () => {
  const good = parseEvalCase({
    version: 1,
    id: "conflict.overlap",
    title: "Conflict",
    capability: "conflict",
    goal: "Detect an overlap.",
    fixture: "site",
    snapshot: "site@1",
    permissions: { read: ["*"], write: [], check: [] },
    budget: { maxTokens: 100, maxToolCalls: 2 },
    criteria: [{ id: "detected", statement: "The overlap is detected." }],
    tools: [],
    unavailable: "No coordination module yet.",
  });
  assert.deepEqual(good.problems, []);

  const missing = parseEvalCase({
    version: 1,
    id: "conflict.overlap",
    title: "Conflict",
    capability: "conflict",
    goal: "Detect an overlap.",
    fixture: "site",
    snapshot: "site@1",
    permissions: { read: ["*"], write: [], check: [] },
    budget: { maxTokens: 100, maxToolCalls: 2 },
    criteria: [{ id: "detected", statement: "The overlap is detected." }],
    tools: [],
  });
  assert.ok(missing.problems.length > 0);
});

test("a suite refuses duplicate case paths", () => {
  const parsed = parseEvalSuite({
    version: 1,
    id: "suite",
    cases: ["cases/a.json", "cases/a.json"],
  });
  assert.ok(parsed.problems.some((problem) => problem.code === "eval.duplicate"));
});
