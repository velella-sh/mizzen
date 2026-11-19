/**
 * #1130/#1131: answerability per acceptance criterion and a precise request for every gap.
 *
 * A criterion is satisfied only when every reference it names — or the whole task scope when it
 * names nothing — has a fragment. An incomplete pack says which reference is missing and turns it
 * into a concrete scope, approval, or evidence request instead of leaving the agent to guess.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { compileTaskContext } from "../src/context/compile.ts";
import { blockPage, page, site, task } from "./context-fixture.ts";

const INSTALL = "# Install the engine\n\nInstall once.\n\n## Steps\n\nRun the installer.\n\n## Troubleshooting\n\nRead the log.\n";
const DEPLOY = "# Deploy\n\nShip the built folder.\n";

function model() {
  return site([
    blockPage("/guide/install/", INSTALL, "Install the engine", "guide/install.md", [["install-steps", 5]]),
    page("/guide/deploy/", DEPLOY, "Deploy", "guide/deploy.md"),
  ]);
}

test("every criterion is checked against its named evidence", async () => {
  const compiled = await compileTaskContext(model(), task({
    scope: { pages: ["/guide/install/"], blocks: ["install-steps"], collections: [], symbols: [], files: [] },
    acceptance: [
      { id: "steps", statement: "The `install-steps` block names the installer.", review: true },
      { id: "file", statement: "`guide/install.md` exists.", review: true },
    ],
  }), { maxTokens: 4000 });
  assert.equal(compiled.answerability.complete, true);
  assert.deepEqual(compiled.answerability.criteria.map((criterion) => criterion.satisfied), [true, true]);
  assert.deepEqual(compiled.answerability.shortages, []);
  assert.deepEqual(compiled.requests, []);
});

test("a criterion with no named reference is answered by the task scope", async () => {
  const compiled = await compileTaskContext(model(), task({
    scope: { pages: ["/guide/install/"], blocks: [], collections: [], symbols: [], files: [] },
    acceptance: [{ id: "review", statement: "A person reviewed the install guide.", review: true }],
  }), { maxTokens: 4000 });
  assert.equal(compiled.answerability.complete, true);
  assert.deepEqual(compiled.answerability.criteria[0]?.evidence, ["/guide/install/"]);
});

test("missing evidence makes the pack incomplete with the exact shortage and scope request", async () => {
  const compiled = await compileTaskContext(model(), task({
    scope: { pages: ["/guide/install/", "/guide/missing/"], blocks: [], collections: [], symbols: [], files: [] },
    acceptance: [
      { id: "missing", statement: "The `missing-page` is documented.", review: true },
      { id: "install", statement: "The install page is present.", review: true },
    ],
  }), { maxTokens: 4000 });
  assert.equal(compiled.answerability.complete, false);
  assert.ok(compiled.answerability.shortages.includes("missing-page"));
  assert.ok(compiled.answerability.shortages.includes("/guide/missing/"));
  const scopeRequest = compiled.requests.find((request) => request.kind === "scope");
  assert.ok(scopeRequest);
  assert.ok(scopeRequest.ref === "/guide/missing/" || scopeRequest.ref.includes("missing"));
  assert.match(scopeRequest.action, /site|scope/);
});

test("a budget shortage becomes an approval request, not a silent omission", async () => {
  const big = "# Big\n\n" + "word ".repeat(1200);
  const bigModel = site([blockPage("/guide/big/", big, "Big", "guide/big.md", [["big-steps", 3]])]);
  const compiled = await compileTaskContext(bigModel, task({
    scope: { pages: ["/guide/big/"], blocks: ["big-steps"], collections: [], symbols: [], files: [] },
    acceptance: [{ id: "big", statement: "`big-steps` is documented.", review: true }],
  }), { maxTokens: 60 });
  assert.equal(compiled.answerability.complete, false);
  assert.ok(compiled.answerability.shortages.includes("big-steps"));
  assert.ok(compiled.requests.some((request) => request.kind === "approval" && request.ref === "big-steps"));
  assert.equal(compiled.fragments.some((fragment) => fragment.source.block === "big-steps"), false);
});
