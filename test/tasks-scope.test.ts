import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTaskContract } from "../src/tasks/contract.ts";
import { registerTask } from "../src/tasks/register.ts";
import { validateScopeReferences, type TaskReferenceIndex } from "../src/tasks/scope.ts";
import { contractInput, registered } from "./tasks-fixture.ts";

/** Every kind of reference the site knows. */
const references: TaskReferenceIndex = {
  pages: new Set(["/guide/install/"]),
  blocks: new Set(["install-steps"]),
  collections: new Set(["blog"]),
  symbols: new Set(["build", "Site.page"]),
  files: new Set(["docs/install.md"]),
};

test("scope combines pages, block ids, collections, symbols, and file paths", () => {
  const contract = parseTaskContract(
    contractInput({
      scope: {
        pages: ["/guide/install/"],
        blocks: ["install-steps"],
        collections: ["blog"],
        symbols: ["Site.page"],
        files: ["docs/install.md"],
      },
    }),
    { references },
  ).contract;

  assert.ok(contract);
  assert.deepEqual(contract.scope, {
    pages: ["/guide/install/"],
    blocks: ["install-steps"],
    collections: ["blog"],
    symbols: ["Site.page"],
    files: ["docs/install.md"],
  });
});

test("an omitted scope kind is present and empty after parsing", () => {
  const contract = parseTaskContract(contractInput()).contract;
  assert.ok(contract);
  assert.deepEqual(contract.scope, { pages: ["/guide/install/"], blocks: [], collections: [], symbols: [], files: [] });
});

test("an empty scope is refused at /scope", () => {
  const result = parseTaskContract(contractInput({ scope: {} }));
  assert.equal(result.contract, undefined);
  const [problem] = result.problems;
  assert.ok(problem);
  assert.equal(problem.path, "/scope");
  assert.equal(problem.code, "task.scope-empty");
});

test("each invalid reference is reported at its own kind and position", () => {
  const scope = {
    pages: ["/missing/"],
    blocks: ["no-such-block"],
    collections: ["no-such-collection"],
    symbols: ["NoSuchSymbol"],
    files: ["docs/missing.md"],
  };
  const problems = parseTaskContract(contractInput({ scope }), { references }).problems;

  assert.deepEqual(
    problems.map((problem) => [problem.path, problem.code]),
    [
      ["/scope/pages/0", "task.scope-unknown"],
      ["/scope/blocks/0", "task.scope-unknown"],
      ["/scope/collections/0", "task.scope-unknown"],
      ["/scope/symbols/0", "task.scope-unknown"],
      ["/scope/files/0", "task.scope-unknown"],
    ],
  );
  assert.match(problems[0]?.message ?? "", /Page `\/missing\/` does not exist/);
  assert.match(problems[4]?.message ?? "", /File `docs\/missing.md` does not exist/);
});

test("a kind the index does not name is not checked or guessed", () => {
  const problems = validateScopeReferences(
    { pages: ["/missing/"], blocks: ["no-such-block"], collections: [], symbols: [], files: [] },
    { blocks: new Set(["install-steps"]) },
  );

  assert.deepEqual(problems.map((problem) => problem.path), ["/scope/blocks/0"]);
});

test("invalid references refuse registration before any task is created", () => {
  const refused = registerTask(
    contractInput({ scope: { pages: ["/missing/"] } }),
    { checks: ["doctor", "test"], references },
  );
  assert.equal(refused.created, false);
  assert.equal(refused.task, undefined);
  assert.equal(refused.problems[0]?.code, "task.scope-unknown");

  const accepted = registerTask(contractInput(), { checks: ["doctor", "test"], references });
  assert.equal(accepted.created, true);
  assert.ok(accepted.task);
});

test("a reference that repeats after trimming is refused", () => {
  const result = parseTaskContract(contractInput({ scope: { pages: ["/guide/install/", " /guide/install/ "] } }));
  assert.equal(result.contract, undefined);
  const [problem] = result.problems;
  assert.ok(problem);
  assert.equal(problem.path, "/scope/pages/1");
  assert.equal(problem.code, "task.duplicate");
});

test("registered tasks keep the scope they were given", () => {
  const task = registered({
    scope: { pages: ["/guide/install/"], blocks: ["install-steps"], files: ["docs/install.md"] },
  });
  assert.deepEqual(task.scope, {
    pages: ["/guide/install/"],
    blocks: ["install-steps"],
    collections: [],
    symbols: [],
    files: ["docs/install.md"],
  });
});
