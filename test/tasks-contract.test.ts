import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import type { TaskContract, TaskProblem } from "../src/contracts/index.ts";
import { parseTaskContract, TASK_CONTRACT_VERSION } from "../src/tasks/contract.ts";

const schema = JSON.parse(
  readFileSync(new URL("../schema/task-contract.schema.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

// ajv is CommonJS: its default export is the class at run time, but its types name it.
const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

/** A minimal valid contract, with the fields a test overrides. */
function input(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    idempotencyKey: "install-1",
    goal: "Update the install guide",
    scope: { pages: ["/guide/install/"] },
    snapshot: {
      content: "a".repeat(64),
      data: "b".repeat(64),
      config: "c".repeat(64),
      tooling: "d".repeat(64),
    },
    budget: { contextTokens: 6000, toolCalls: 20, timeMs: 60000 },
    acceptance: [{ id: "doctor", statement: "The doctor passes", check: "doctor" }],
    ...extra,
  };
}

/** Parses a contract that must be valid, and returns it. */
function parsed(value: unknown): TaskContract {
  const result = parseTaskContract(value, { checks: ["doctor", "test"] });
  assert.deepEqual(result.problems, []);
  assert.ok(result.contract, "a valid contract has a contract");
  return result.contract;
}

/** Parses a contract that must be refused, and returns its problems. */
function refused(value: unknown): readonly TaskProblem[] {
  const result = parseTaskContract(value, { checks: ["doctor", "test"] });
  assert.equal(result.contract, undefined);
  assert.ok(result.problems.length > 0, "a refused contract has problems");
  return result.problems;
}

test("the contract schema is closed, versioned, and covers every required part", () => {
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, [
    "version",
    "idempotencyKey",
    "goal",
    "scope",
    "snapshot",
    "budget",
    "acceptance",
  ]);
  assert.equal(TASK_CONTRACT_VERSION, 1);
});

test("a full contract round-trips through the schema and the parser unchanged", () => {
  const contract = parsed(
    input({
      goal: "  Update the install guide  ",
      scope: { pages: [" /guide/install/ "], blocks: ["install-steps"], collections: ["blog"], symbols: ["build"], files: ["docs/install.md"] },
      permissions: { read: ["alice", "bob"], write: ["alice"], check: ["*"] },
    }),
  );

  assert.equal(contract.goal, "Update the install guide");
  assert.deepEqual(contract.scope, {
    pages: ["/guide/install/"],
    blocks: ["install-steps"],
    collections: ["blog"],
    symbols: ["build"],
    files: ["docs/install.md"],
  });
  assert.match(contract.snapshot.id, /^[0-9a-f]{64}$/);
  assert.deepEqual(contract.permissions, { read: ["alice", "bob"], write: ["alice"], check: ["*"] });

  assert.equal(validate(contract), true, validate.errors?.map((error) => `${error.instancePath} ${error.message}`).join("; ") ?? "");
  const encoded = JSON.stringify(contract);
  assert.deepEqual(JSON.parse(encoded), contract);
  assert.equal(JSON.stringify(parsed(JSON.parse(encoded))), encoded);
});

test("a minimal contract gets the documented permissions defaults", () => {
  const contract = parsed(input());
  assert.deepEqual(contract.permissions, { read: ["*"], write: [], check: [] });
});

test("an unknown version is refused at /version", () => {
  const [problem] = refused(input({ version: 2 }));
  assert.ok(problem);
  assert.equal(problem.path, "/version");
  assert.equal(problem.code, "task.version");
  assert.match(problem.message, /Only task-contract version 1/);
});

test("an unknown field is refused with its location and the allowed keys", () => {
  const [problem] = refused(input({ priority: 1 }));
  assert.ok(problem);
  assert.equal(problem.path, "/priority");
  assert.equal(problem.code, "task.unknown-key");
  assert.match(problem.message, /`acceptance`.*`version`/);
});

test("a wrongly typed field is refused with its location", () => {
  const [problem] = refused(input({ budget: { contextTokens: "6000", toolCalls: 20, timeMs: 60000 } }));
  assert.ok(problem);
  assert.equal(problem.path, "/budget/contextTokens");
  assert.equal(problem.code, "task.type");
  assert.match(problem.message, /must be an integer; found a string/);
});

test("a missing required field is refused with its location", () => {
  const value = input();
  delete value.goal;
  const [problem] = refused(value);
  assert.ok(problem);
  assert.equal(problem.path, "/goal");
  assert.equal(problem.code, "task.missing");
});

test("an acceptance criterion with neither a check nor a review is refused at its own path", () => {
  const [problem] = refused(input({ acceptance: [{ id: "ambiguous", statement: "It works" }] }));
  assert.ok(problem);
  assert.equal(problem.path, "/acceptance/0");
  assert.equal(problem.code, "task.acceptance-shape");
  assert.match(problem.message, /exactly one of `check`.*`review: true`/);
});
