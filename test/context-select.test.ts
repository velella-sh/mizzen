/**
 * #1122/#1123: entry points and their transitive dependency closure.
 *
 * The task scope selects pages and blocks with a stable reason, the goal only adds pages that match
 * a term, and the closure follows links, includes, data, API, and acceptance edges to a fixed depth
 * and node cap. A cycle is reported and rejected instead of repeated.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { GraphInput } from "../src/contracts/index.ts";
import { buildGraph } from "../src/graph/build.ts";
import { selectFromGraph } from "../src/context/select.ts";
import { blockPage, page, site, task } from "./context-fixture.ts";

const INSTALL = "# Install the engine\n\nInstall once.\n\n## Steps\n\nRun the installer.\n";
const SETUP = "# Set up a project\n\nCreate the project.\n\n## Config\n\nWrite the config file.\n";
const DEPLOY = "# Deploy\n\nShip the built folder to the server.\n";

function baseSite() {
  return site([
    blockPage("/guide/install/", INSTALL, "Install the engine", "guide/install.md", [["install-steps", 5]]),
    page("/guide/setup/", SETUP, "Set up a project", "guide/setup.md"),
    page("/guide/deploy/", DEPLOY, "Deploy", "guide/deploy.md"),
  ]);
}

function graph(input: Partial<GraphInput> = {}) {
  return buildGraph({ site: baseSite(), ...input }).graph;
}

test("scope pages and blocks are entries with their own reasons", () => {
  const siteModel = baseSite();
  const selection = selectFromGraph(graph(), siteModel, task({
    scope: { pages: ["/guide/install/"], blocks: ["install-steps"], collections: [], symbols: [], files: [] },
  }));
  const reasons = selection.entries.map((entry) => [entry.kind, entry.reason]);
  assert.ok(reasons.some(([kind, reason]) => kind === "page" && reason === "scope.page"));
  assert.ok(reasons.some(([kind, reason]) => kind === "block" && reason === "scope.block"));
  assert.equal(selection.entries.filter((entry) => entry.kind === "page" && entry.label === "Deploy").length, 0);
});

test("the closure follows links and includes with dependency reasons", () => {
  const siteModel = baseSite();
  const input: GraphInput = {
    site: siteModel,
    links: [{
      page: "guide/install.md",
      href: "guide/setup.md",
      target: "guide/setup.md",
      pos: { file: "guide/install.md", line: 7, column: 1, endLine: 7, endColumn: 20 },
    }],
    includes: [{
      from: "guide/install.md",
      path: "partials/note.md",
      pos: { file: "guide/install.md", line: 3, column: 1, endLine: 3, endColumn: 1 },
    }],
  };
  const selection = selectFromGraph(buildGraph(input).graph, siteModel, task({
    scope: { pages: ["/guide/install/"], blocks: [], collections: [], symbols: [], files: [] },
  }));
  const reasons = selection.dependencies.map((edge) => edge.reason);
  assert.ok(reasons.includes("dependency.link"));
  assert.ok(reasons.includes("dependency.include"));
  assert.ok(selection.entries.some((entry) => entry.label === "Set up a project"));
  assert.ok(selection.entries.some((entry) => entry.kind === "include"));
});

test("the node cap leaves a scope omission rather than a partial answer", () => {
  const siteModel = baseSite();
  const selection = selectFromGraph(
    graph(),
    siteModel,
    task({ scope: { pages: ["/guide/install/", "/guide/setup/"], blocks: [], collections: [], symbols: [], files: [] } }),
    { maxNodes: 1 },
  );
  assert.equal(selection.entries.length, 1);
  assert.ok(selection.omitted.some((entry) => entry.reason === "scope" && entry.detail.includes("stops at 1")));
});

test("a cycle is detected and rejected, with one entry per node", () => {
  const siteModel = baseSite();
  const pos = { file: "guide/install.md", line: 7, column: 1, endLine: 7, endColumn: 20 };
  const graphWithCycle = buildGraph({
    site: siteModel,
    links: [
      { page: "guide/install.md", href: "guide/setup.md", target: "guide/setup.md", pos },
      { page: "guide/setup.md", href: "guide/install.md", target: "guide/install.md", pos: { ...pos, file: "guide/setup.md" } },
    ],
  }).graph;
  const selection = selectFromGraph(graphWithCycle, siteModel, task({
    scope: { pages: ["/guide/install/"], blocks: [], collections: [], symbols: [], files: [] },
  }), { maxDepth: 6 });
  assert.ok(selection.cycles.length > 0);
  assert.ok(selection.omitted.some((entry) => entry.detail.includes("cycle")));
  const pages = selection.entries.filter((entry) => entry.kind === "page").map((entry) => entry.id);
  assert.equal(new Set(pages).size, pages.length);
});

test("an unresolved scope reference is a scope omission, not an invented entry", () => {
  const siteModel = baseSite();
  const selection = selectFromGraph(graph(), siteModel, task({
    scope: { pages: ["/guide/missing/"], blocks: [], collections: [], symbols: [], files: [] },
  }));
  assert.equal(selection.entries.some((entry) => entry.label.includes("missing")), false);
  assert.deepEqual(
    selection.omitted.filter((entry) => entry.reason === "scope" && entry.ref === "/guide/missing/").map((entry) => entry.ref),
    ["/guide/missing/"],
  );
});
