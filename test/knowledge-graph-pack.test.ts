/**
 * #1370 and #1373: propagate knowledge status to the graph and to context packs, keep a query outside a declaration's
 * scope from being a definitive answer, and publish only the safe public projection.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { buildGraph } from "../src/graph/build.ts";
import { collectGraphInput } from "../src/graph/collect.ts";
import { queryGraph } from "../src/graph/query.ts";
import { compilePack } from "../src/packs/compile.ts";
import { buildModel } from "../src/model/build.ts";
import type { ContextRequest } from "../src/contracts/context-request.ts";
import type { OutputContext } from "../src/contracts/output.ts";

/** A temporary site holding `files`. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "knowledge-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** A context request that names one page as required evidence. */
function request(goal: string, refs: string[]): ContextRequest {
  return {
    version: 1,
    task: { goal },
    include: [],
    exclude: [],
    constraints: {},
    budget: { maxTokens: 6000 },
    requiredEvidence: { refs, source: true, versions: false, warnings: false, dependencies: false },
  };
}

/** A no-op output context, since a pack compiles no pages. */
function ctx(): OutputContext {
  return { renderPage: () => Promise.reject(new Error("no pages")), report: () => {} };
}

const SITE = {
  "mizzen.yml": "title: T\n",
  "index.md": "---\ntitle: Home\n---\n\n# Home\n\nSee [Windows](/windows/).\n",
  "windows.md":
    "---\ntitle: Install on Windows\nknowledge:\n  status: unknown\n  scope: [platform:windows]\n  rationale: no known answer\n  citation: https://private.example/note\n---\n\n# Install on Windows\n\nThere is no confirmed answer for Windows.\n",
};

test("#1370 the graph carries a node's status and scope", async () => {
  const root = tree(SITE);
  try {
    const { site } = await buildModel(root);
    const { graph } = buildGraph(await collectGraphInput({ root, site }));
    const page = graph.nodes.find((node) => node.id === "page:windows.md");
    assert.equal(page?.knowledge?.status, "unknown");
    assert.deepEqual(page?.knowledge?.scope, [{ kind: "platform", value: "windows" }]);
    // A private citation value never reaches the graph.
    assert.equal(page?.knowledge?.citations, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1370 a query outside the declaration's scope is not a definitive answer", async () => {
  const root = tree(SITE);
  try {
    const { site } = await buildModel(root);
    const { graph } = buildGraph(await collectGraphInput({ root, site }));
    // Home links to the Windows page, so the bounded query surfaces it as a neighbor with its own status.
    const neighbor = (scope: readonly { readonly kind: "surface" | "behavior" | "platform" | "version"; readonly value: string }[] | undefined) =>
      queryGraph(graph, { from: "page:index.md", depth: 2, ...(scope === undefined ? {} : { scope }) }).neighbors.find(
        (entry) => entry.node.id === "page:windows.md",
      )?.node;

    const inside = neighbor([{ kind: "platform", value: "windows" }]);
    assert.equal(inside?.knowledge?.status, "unknown");
    assert.equal(inside?.definitive, true);

    const outside = neighbor([{ kind: "platform", value: "linux" }]);
    assert.equal(outside?.definitive, false, "a query about another platform is not definitive");

    // With no scope named, a limited declaration cannot claim to answer everything.
    const unknownScope = neighbor(undefined);
    assert.equal(unknownScope?.definitive, false);

    const result = queryGraph(graph, { from: "page:windows.md", depth: 0, scope: [{ kind: "platform", value: "linux" }] });
    assert.equal(result.definitive, false, "an out-of-scope query is not definitive");
    assert.deepEqual(result.knowledge, [{ id: "page:windows.md", status: "unknown" }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1370 and #1373 a pack carries the status but never the private rationale or citation", async () => {
  const root = tree(SITE);
  try {
    const { site } = await buildModel(root);
    const compiled = await compilePack(site, request("install on windows", ["windows.md"]), ctx());
    assert.ok(compiled, "the pack compiles");
    const item = compiled.evidence.items.find((entry) => entry.id === "/windows/");
    assert.equal(item?.knowledge?.status, "unknown");
    assert.deepEqual(item?.knowledge?.scope, [{ kind: "platform", value: "windows" }]);
    assert.equal(item?.knowledge?.citations, undefined);
    assert.equal(compiled.evidence.knowledge.counts.unknown, 1);
    assert.deepEqual(compiled.evidence.knowledge.limited, ["/windows/"]);
    // A page that declares nothing is in `missing`, never counted as one of the five statuses.
    assert.ok(compiled.evidence.knowledge.missing.includes("/"), "the home page declares nothing");
    assert.equal(compiled.evidence.knowledge.missing.includes("/windows/"), false);
    const text = JSON.stringify(compiled.evidence);
    assert.doesNotMatch(text, /private\.example|no known answer/);
    // The Markdown twin says the same status, so the two files cannot disagree.
    assert.match(compiled.markdown, /- Knowledge: unknown; scope platform:windows/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1373 a public citation is published while a private one is left out", async () => {
  const root = tree({
    "mizzen.yml": "title: T\n",
    "a.md": "---\ntitle: A\nknowledge:\n  status: unverified\n  citation:\n    value: https://docs.example/proof\n    public: true\n---\n\n# A\n",
  });
  try {
    const { site } = await buildModel(root);
    const compiled = await compilePack(site, request("a", ["a.md"]), ctx());
    const item = compiled?.evidence.items[0];
    assert.deepEqual(item?.knowledge?.citations, ["https://docs.example/proof"]);
    assert.match(compiled?.markdown ?? "", /cites https:\/\/docs\.example\/proof/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
