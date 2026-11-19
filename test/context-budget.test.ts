/**
 * #1127-#1129: a fixed budget with stable priority, visible accounting, and explained omissions.
 *
 * Priority is fixed before the budget is read, so the same fragments keep their order at every
 * size. A fragment is admitted whole or refused with the exact shortfall. The accounting splits
 * fragment estimates, template overhead, and safety margin, and the three add to `used` exactly.
 * Omitted inputs carry budget, permission, scope, or irrelevance, and never appear as fragments.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { compileTaskContext } from "../src/context/compile.ts";
import { packContext, renderContext } from "../src/context/budget.ts";
import type { ContextFragment } from "../src/context/types.ts";
import { estimatePack, estimateTokens } from "../src/packs/tokens.ts";
import { blockPage, page, site, task } from "./context-fixture.ts";

const INSTALL = "# Install the engine\n\nInstall once.\n\n## Steps\n\nRun the installer.\n\n## Troubleshooting\n\nRead the log when the installer fails.\n";
const DEPLOY = "# Deploy\n\nShip the built folder.\n\n## Rollback\n\nRestore the previous release.\n";

function fragment(id: string, reason: string, content: string, refs: readonly string[] = []): ContextFragment {
  return {
    id,
    kind: "page",
    title: id,
    content,
    source: { file: `${id}.md`, span: `${id}.md:1:1-1:1`, snapshot: "build-1" },
    tokens: estimateTokens(content).tokens,
    reason,
    via: [reason],
    refs,
  };
}

test("priority order does not depend on the budget, and every admitted pack fits", () => {
  const fragments = [
    fragment("entry", "scope.page", "entry content", ["/page/"]),
    fragment("dep", "dependency.link", "dependency content"),
    fragment("lineage", "lineage.rule", "lineage content"),
    fragment("mandatory", "acceptance.review", "mandatory content", ["required"]),
  ];
  const orders: string[][] = [];
  for (const budget of [120, 240, 480, 960]) {
    const packed = packContext("a task", fragments, budget);
    assert.ok(packed.estimate.used <= budget, `${packed.estimate.used} > ${budget}`);
    orders.push(packed.fragments.map((entry) => entry.id));
    const order = orders[orders.length - 1]!;
    assert.ok(order.indexOf("mandatory") < order.indexOf("dep") || !order.includes("dep"));
    assert.ok(order.indexOf("dep") < order.indexOf("lineage") || !order.includes("lineage"));
  }
  const allOrder = ["entry", "mandatory", "dep", "lineage"];
  for (const order of orders) {
    assert.deepEqual(order, allOrder.filter((id) => order.includes(id)));
  }
});

test("a fragment that does not fit is refused whole, with the shortfall", () => {
  const big = fragment("big", "scope.page", "word ".repeat(400), ["/big/"]);
  const small = fragment("small", "scope.page", "tiny", ["/small/"]);
  const packed = packContext("a task", [big, small], 120);
  assert.deepEqual(packed.fragments.map((entry) => entry.id), ["small"]);
  assert.equal(packed.omitted[0]?.reason, "budget");
  assert.match(packed.omitted[0]?.detail ?? "", /over the 120-token budget/);
});

test("estimate and accounting agree exactly", () => {
  const fragments = [fragment("one", "scope.page", "one body", ["/one/"])];
  const markdown = renderContext("a task", fragments);
  const template = renderContext("a task", fragments, false);
  const estimate = estimatePack(markdown, fragments.map((entry) => entry.content), template);
  assert.equal(estimate.fragments + estimate.template + estimate.safety, estimate.used);
  assert.equal(estimate.used, estimate.upper);
  assert.ok(estimate.safety > 0);
});

test("compiled accounting publishes per-fragment costs and a used total that adds up", async () => {
  const model = site([
    blockPage("/guide/install/", INSTALL, "Install the engine", "guide/install.md", [["install-steps", 5]]),
    page("/guide/deploy/", DEPLOY, "Deploy", "guide/deploy.md"),
  ]);
  const compiled = await compileTaskContext(model, task({
    scope: { pages: ["/guide/install/"], blocks: [], collections: [], symbols: [], files: [] },
  }), { maxTokens: 2000 });
  const accounting = compiled.accounting;
  assert.equal(accounting.fragments + accounting.template + accounting.safety, accounting.used);
  assert.equal(accounting.used, accounting.upper);
  assert.equal(accounting.perFragment.length, compiled.fragments.length);
  assert.deepEqual(accounting.perFragment.map((entry) => entry.id), compiled.fragments.map((entry) => entry.id));
  assert.ok(accounting.used <= 2000);
  assert.equal(accounting.remaining, 2000 - accounting.used);
});

test("a scope omission and a budget omission never appear as fragments", async () => {
  const model = site([page("/guide/install/", INSTALL, "Install", "guide/install.md")]);
  const compiled = await compileTaskContext(model, task({
    scope: { pages: ["/guide/missing/"], blocks: [], collections: [], symbols: [], files: [] },
  }), { maxTokens: 1 });
  const reasons = new Set(compiled.omitted.map((entry) => entry.reason));
  assert.ok(reasons.has("scope"));
  assert.ok(reasons.has("budget") || compiled.fragments.length === 0);
  for (const omission of compiled.omitted) {
    assert.equal(compiled.fragments.some((fragment) => fragment.id === omission.ref), false);
    assert.equal(compiled.markdown.includes(`# ${omission.ref}`), false);
  }
});
