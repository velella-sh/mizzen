/** Coverage for the evaluation case and suite parser's shape, cross-field, and read failures. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseEvalCase, parseEvalSuite, readEvalCase, readEvalSuite } from "../src/evals/case.ts";

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

test("an unknown field, an invalid enum, and a malformed expectation each name their pointer", () => {
  const unknown = parseEvalCase(validCase({ surprise: true }));
  assert.ok(unknown.problems.some((problem) => problem.path === "" && problem.code === "eval.invalid-value" && problem.message.length > 0));

  const invalid = parseEvalCase(validCase({ capability: "bogus" }));
  assert.ok(invalid.problems.some((problem) => problem.code === "eval.invalid-value" && problem.message.includes("must be one of")));

  const shape = parseEvalCase(validCase({ expected: { kind: "answer" } }));
  assert.ok(shape.problems.some((problem) => problem.code === "eval.invalid-value" && problem.message.includes("documented shapes")));
});

test("a fixture and an input that the schema accepts but the cross-field check refuses are relative-path problems", () => {
  const fixture = parseEvalCase(validCase({ fixture: "site//nested" }));
  assert.ok(fixture.problems.some((problem) => problem.path === "/fixture" && problem.code === "eval.relative-path"));

  for (const key of ["agent", "policy", "transaction", "proof", "input", "handoff"] as const) {
    const parsed = parseEvalCase(validCase({ inputs: { [key]: `./${key}.json` } }));
    assert.ok(
      parsed.problems.some((problem) => problem.path === `/inputs/${key}` && problem.code === "eval.relative-path"),
      key,
    );
  }
});

test("each capability names the input it needs", () => {
  const cases: readonly [string, Record<string, unknown>, string][] = [
    [
      "transaction",
      { kind: "transaction", outcome: "applied", invariant: null, attempted: ["write"], changed: [] },
      "/inputs/transaction",
    ],
    ["verification", { kind: "verification", verdict: "proved" }, "/inputs"],
    ["conflict", { kind: "conflict", overlap: ["a"], resolution: "rejected" }, "/inputs/split"],
    ["handoff", { kind: "handoff", nextAction: "write", applied: [], remaining: [], duplicateRefused: false }, "/inputs/handoff"],
  ];
  for (const [capability, expected, path] of cases) {
    const parsed = parseEvalCase(validCase({ capability, inputs: {}, expected }));
    assert.ok(
      parsed.problems.some((problem) => problem.path === path && problem.code === "eval.missing-input"),
      capability,
    );
  }
});

test("a suite with the wrong shape and a case path with a dot segment are refused", () => {
  const shape = parseEvalSuite({ version: 1 });
  assert.ok(shape.problems.some((problem) => problem.code === "eval.missing-field" && problem.message.includes("`id`")));

  const relative = parseEvalSuite({ version: 1, id: "suite", cases: ["./cases/a.json"] });
  assert.ok(relative.problems.some((problem) => problem.path === "/cases/0" && problem.code === "eval.relative-path"));
});

test("duplicate ids and tool names, a capability mismatch, a permission policy, and an unsafe schema path are refused", () => {
  const duplicated = parseEvalCase(validCase({
    criteria: [{ id: "same", statement: "First." }, { id: "same", statement: "Second." }],
    tools: [{ name: "context", version: "1" }, { name: "context", version: "2" }],
  }));
  assert.ok(duplicated.problems.some((problem) => problem.path === "/criteria/1" && problem.code === "eval.duplicate"));
  assert.ok(duplicated.problems.some((problem) => problem.path === "/tools/1" && problem.code === "eval.duplicate"));

  const mismatch = parseEvalCase(validCase({ capability: "discovery", inputs: { agent: "agents/answer.json" } }));
  assert.ok(mismatch.problems.some((problem) => problem.path === "/expected/kind" && problem.code === "eval.capability-mismatch"));

  const permission = parseEvalCase(validCase({
    capability: "permission",
    inputs: { agent: "agents/permission.json" },
    expected: { kind: "permission", attempts: [{ capability: "read", target: "/secret/" }] },
  }));
  assert.ok(permission.problems.some((problem) => problem.path === "/inputs/policy" && problem.code === "eval.missing-input"));

  const unsafe = parseEvalCase(validCase({ fixture: "../outside" }));
  assert.ok(unsafe.problems.some((problem) => problem.path === "/fixture" && problem.code === "eval.relative-path"));
});

test("a missing case, a missing suite, an invalid case JSON, and an invalid suite JSON are located problems", async () => {
  const dir = mkdtempSync(join(tmpdir(), "coverage-evals-"));
  try {
    const missing = await readEvalCase(join(dir, "missing.json"));
    assert.equal(missing.problems[0]?.code, "eval.unreadable");
    assert.ok(missing.problems[0]?.message.includes("cannot read the case"));

    const missingSuite = await readEvalSuite(join(dir, "missing.json"));
    assert.equal(missingSuite.problems[0]?.code, "eval.unreadable");
    assert.ok(missingSuite.problems[0]?.message.includes("cannot read the suite"));

    const badCase = join(dir, "case.json");
    writeFileSync(badCase, "{");
    const invalidCase = await readEvalCase(badCase);
    assert.equal(invalidCase.problems[0]?.code, "eval.invalid-json");
    assert.ok(invalidCase.problems[0]?.message.includes("not valid JSON"));

    const badSuite = join(dir, "suite.json");
    writeFileSync(badSuite, "{");
    const invalidSuite = await readEvalSuite(badSuite);
    assert.equal(invalidSuite.problems[0]?.code, "eval.invalid-json");
    assert.ok(invalidSuite.problems[0]?.message.includes("the suite is not valid JSON"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
