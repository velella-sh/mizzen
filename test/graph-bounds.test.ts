import assert from "node:assert/strict";
import { test } from "node:test";
import type { Graph, GraphEdge, GraphNode } from "../src/contracts/index.ts";
import { queryGraph } from "../src/graph/query.ts";

function node(id: string): GraphNode {
  return { id, kind: "page", label: id };
}

const nodes = Array.from({ length: 12 }, (_, index) => node(`n:${index}`));
const chain: GraphEdge[] = Array.from({ length: 11 }, (_, index) => ({ from: `n:${index}`, to: `n:${index + 1}`, kind: "links" }));
const edges: GraphEdge[] = [...chain, { from: "n:11", to: "n:0", kind: "links" }];
const graph: Graph = {
  format: 1,
  snapshot: { format: 1, id: "bounds" },
  nodes,
  edges,
};

test("depth and node limits bound a cyclic graph and mark the answer partial", () => {
  const depth = queryGraph(graph, { snapshot: "bounds", from: "n:0", depth: 2 });
  assert.equal(depth.partial, false);
  assert.deepEqual(depth.neighbors.map((entry) => entry.node.id), ["n:1", "n:2"]);

  const bounded = queryGraph(graph, { snapshot: "bounds", from: "n:0", depth: 10, nodes: 3 });
  assert.equal(bounded.partial, true);
  assert.equal(bounded.reason, "nodes");
  assert.ok(bounded.cursor, "a node-bounded answer is resumable");
  assert.ok(bounded.neighbors.length > 0);
});

test("an output-bounded answer resumes through its cursor until complete", () => {
  const full = queryGraph(graph, { snapshot: "bounds", from: "n:0", depth: 10, nodes: 100 });
  const collected: string[] = [];
  let cursor: string | undefined;
  let rounds = 0;
  do {
    const chunk = queryGraph(graph, {
      snapshot: "bounds",
      from: "n:0",
      depth: 10,
      nodes: 100,
      maxOutput: 120,
      ...(cursor === undefined ? {} : { cursor }),
    });
    collected.push(...chunk.neighbors.map((entry) => `${entry.direction}:${entry.edge.from}->${entry.edge.to}`));
    cursor = chunk.cursor;
    rounds += 1;
    assert.ok(rounds < 100, "the cursor makes progress");
  } while (cursor !== undefined);
  assert.deepEqual(collected, full.neighbors.map((entry) => `${entry.direction}:${entry.edge.from}->${entry.edge.to}`));
});
