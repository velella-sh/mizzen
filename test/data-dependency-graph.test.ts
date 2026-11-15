import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { sha256, storedPath, writeLock } from "../src/data/lock.ts";
import { buildModel } from "../src/model/build.ts";
import { affectedNodes, buildDependencyGraph, fileNodeId, outputNodeId } from "../src/pipeline/dependency-graph.ts";
import { planInvalidation } from "../src/pipeline/invalidation.ts";

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "data-graph-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const SITE = {
  "mizzen.yml": "collections:\n  authors:\n    source: _data/authors.yml\n",
  "_data/authors.yml": "- id: memo\n  name: Memo\n- id: nadia\n  name: Nadia\n",
  "_data/navigation.yml": "main:\n  - title: Alpha\n    url: /alpha/\n  - title: Beta\n    url: /beta/\n",
  "alpha.md": "# Alpha\n\n:data[authors.memo.name]\n",
  "beta.md": "# Beta\n",
};

test("a page that reads a collection depends on that one source, and a page that does not has no edge", async () => {
  const root = tree(SITE);
  try {
    const { site } = await buildModel(root);
    const { graph, diagnostics } = await buildDependencyGraph({ root, site });
    assert.deepEqual(diagnostics, []);
    const pairs = graph.edges.map((edge) => `${edge.from} -> ${edge.to}`);
    assert.ok(pairs.includes(`${fileNodeId("alpha.md")} -> ${fileNodeId("_data/authors.yml")}`));
    assert.equal(pairs.some((pair) => pair.startsWith(`${fileNodeId("beta.md")} -> ${fileNodeId("_data/authors.yml")}`)), false);

    const affected = affectedNodes(graph, ["_data/authors.yml"]);
    assert.ok(affected.includes(fileNodeId("alpha.md")));
    assert.ok(affected.includes(outputNodeId("/alpha/")));
    assert.equal(affected.includes(fileNodeId("beta.md")), false);
    assert.equal(affected.includes(outputNodeId("/beta/")), false);

    const plan = planInvalidation({ graph, changes: [{ kind: "changed", path: "_data/authors.yml" }] });
    assert.deepEqual(plan.outputs.map((output) => output.url), ["/alpha/"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a directive the graph cannot resolve makes the graph incomplete, so the plan is a full build", async () => {
  const root = tree({ ...SITE, "alpha.md": "# Alpha\n\n:data[unknown.path]\n" });
  try {
    const { site } = await buildModel(root);
    const { graph } = await buildDependencyGraph({ root, site });
    assert.ok(graph.incomplete?.length);
    const plan = planInvalidation({ graph, changes: [{ kind: "changed", path: "_data/authors.yml" }] });
    assert.equal(plan.complete, true);
    assert.deepEqual(plan.outputs.map((output) => output.url), ["/alpha/", "/beta/"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("npm and https sources are graph nodes for both :data and ::data-table", async () => {
  const npmBytes = "- id: a\n  name: Alpha\n";
  const webBytes = "- id: w\n  name: Web\n";
  const npmHash = sha256(npmBytes);
  const webHash = sha256(webBytes);
  const root = tree({
    "mizzen.yml":
      "collections:\n  local:\n    source: npm:pkg/items.yml\n  web:\n    source: https://example.test/items.yml\n",
    "_data/navigation.yml":
      "main:\n  - title: Alpha\n    url: /alpha/\n  - title: Beta\n    url: /beta/\n  - title: Gamma\n    url: /gamma/\n  - title: Delta\n    url: /delta/\n",
    "node_modules/pkg/package.json": JSON.stringify({ name: "pkg", version: "1.0.0" }),
    "node_modules/pkg/items.yml": npmBytes,
    "alpha.md": "# Alpha\n\n:data[local.a.name]\n",
    "beta.md": "::data-table{from=local columns=name}\n",
    "gamma.md": "# Gamma\n\n:data[web.w.name]\n",
    "delta.md": "::data-table{from=web columns=name}\n",
  });
  try {
    const stored = storedPath(root, webHash);
    mkdirSync(dirname(stored), { recursive: true });
    writeFileSync(stored, webBytes);
    await writeLock(root, {
      version: 1,
      sources: {
        "npm:pkg/items.yml": {
          address: "npm:pkg/items.yml",
          version: "1.0.0",
          bytes: Buffer.byteLength(npmBytes),
          sha256: npmHash,
        },
        "https://example.test/items.yml": {
          address: "https://example.test/items.yml",
          bytes: Buffer.byteLength(webBytes),
          sha256: webHash,
        },
      },
    });

    const { site, diagnostics } = await buildModel(root);
    assert.deepEqual(diagnostics, []);
    const { graph } = await buildDependencyGraph({ root, site });
    const npmNode = graph.nodes.find((node) => node.path.endsWith("node_modules/pkg/items.yml"));
    const webNode = graph.nodes.find((node) => node.path.endsWith(`.mizzen/data/${webHash}`));
    assert.ok(npmNode);
    assert.ok(webNode);

    const pairs = graph.edges.map((edge) => `${edge.from} -> ${edge.to}`);
    for (const page of ["alpha.md", "beta.md"]) {
      assert.ok(pairs.includes(`${fileNodeId(page)} -> ${npmNode.id}`), `${page} reads npm`);
    }
    for (const page of ["gamma.md", "delta.md"]) {
      assert.ok(pairs.includes(`${fileNodeId(page)} -> ${webNode.id}`), `${page} reads https`);
    }

    const npmAffected = affectedNodes(graph, [npmNode.path]);
    assert.ok(npmAffected.includes(outputNodeId("/alpha/")));
    assert.ok(npmAffected.includes(outputNodeId("/beta/")));
    assert.equal(npmAffected.includes(outputNodeId("/gamma/")), false);
    assert.deepEqual(
      planInvalidation({ graph, changes: [{ kind: "changed", path: npmNode.path }] }).outputs.map((output) => output.url),
      ["/alpha/", "/beta/"],
    );

    const webAffected = affectedNodes(graph, [webNode.path]);
    assert.ok(webAffected.includes(outputNodeId("/gamma/")));
    assert.ok(webAffected.includes(outputNodeId("/delta/")));
    assert.equal(webAffected.includes(outputNodeId("/alpha/")), false);
    assert.deepEqual(
      planInvalidation({ graph, changes: [{ kind: "changed", path: webNode.path }] }).outputs.map((output) => output.url),
      ["/delta/", "/gamma/"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unresolvable data directive makes the plan a full build for every collection change", async () => {
  const root = tree({
    "mizzen.yml":
      "collections:\n  one:\n    source: _data/one.yml\n  two:\n    source: _data/two.yml\n",
    "_data/one.yml": "- id: a\n  name: A\n",
    "_data/two.yml": "- id: b\n  name: B\n",
    "_data/navigation.yml": "main:\n  - title: Alpha\n    url: /alpha/\n  - title: Beta\n    url: /beta/\n",
    "alpha.md": "# Alpha\n\n:data[unknown.path]\n",
    "beta.md": "# Beta\n",
  });
  try {
    const { site } = await buildModel(root);
    const { graph } = await buildDependencyGraph({ root, site });
    assert.ok(graph.incomplete?.length);

    for (const path of ["_data/one.yml", "_data/two.yml"]) {
      const plan = planInvalidation({ graph, changes: [{ kind: "changed", path }] });
      assert.equal(plan.complete, true, `${path} needs a full build`);
      assert.deepEqual(plan.outputs.map((output) => output.url), ["/alpha/", "/beta/"]);
      assert.ok(plan.reasons.some((reason) => reason.kind === "unknown"));
      assert.deepEqual(affectedNodes(graph, [path]).sort(), [outputNodeId("/alpha/"), outputNodeId("/beta/")].sort());
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
