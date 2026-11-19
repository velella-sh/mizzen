/** `query_graph`: query the current knowledge-graph snapshot through the same schema and node ids the CLI uses. */
import { buildGraph } from "../../graph/build.ts";
import { collectGraphInput } from "../../graph/collect.ts";
import { cursorSnapshot, queryGraph, type GraphDirection, type GraphQueryOptions } from "../../graph/query.ts";
import type { GraphEdgeKind } from "../../contracts/index.ts";
import { McpError } from "../limits.ts";
import { json, type Tool } from "../tool.ts";

interface Input {
  readonly snapshot?: string;
  readonly from?: string;
  readonly to?: string;
  readonly depth?: number;
  readonly nodes?: number;
  readonly maxOutput?: number;
  readonly cursor?: string;
  readonly direction?: GraphDirection;
  readonly kinds?: readonly GraphEdgeKind[];
  readonly allow?: readonly string[];
}

export const tool: Tool<Input> = {
  name: "query_graph",
  description:
    "Query the source and documentation knowledge graph: the visible neighbors of `from`, and the shortest path from `from` to `to`, with the same node ids and JSON the `mizzen graph` command prints. A bounded answer is `partial` and carries a `cursor`; nodes above the caller's allowed audiences are absent.",
  inputSchema: {
    type: "object",
    properties: {
      snapshot: { type: "string", minLength: 1, description: "The snapshot to read (default: the current build)." },
      from: { type: "string", minLength: 1, description: "The starting node id, such as page:guide.md." },
      to: { type: "string", minLength: 1, description: "The node to reach, for the shortest path." },
      depth: { type: "integer", minimum: 0, maximum: 32, description: "Longest path from `from` (default 3)." },
      nodes: { type: "integer", minimum: 1, maximum: 1000, description: "Most nodes in the neighbor answer (default 100)." },
      maxOutput: { type: "integer", minimum: 1, description: "Most characters in the neighbor answer (default 100000)." },
      cursor: { type: "string", description: "Continue a partial answer." },
      direction: { enum: ["out", "in", "both"], description: "Which way edges are followed (default out)." },
      kinds: { type: "array", items: { type: "string" }, description: "Edge kinds to follow; every kind when absent." },
      allow: { type: "array", items: { type: "string" }, description: "Audiences the caller may read; without it only public nodes are visible." },
    },
    additionalProperties: false,
  },
  async handler(input, { site }) {
    const graphInput = await collectGraphInput({ root: site.root, site: site.site });
    const { graph } = buildGraph(graphInput);
    const current = graph.snapshot.id;
    if (input.snapshot !== undefined && input.snapshot !== current) {
      throw new McpError("stale-snapshot", `Snapshot ${input.snapshot} is not the current build (${current}); query the current snapshot.`, {
        retryable: true,
        stage: "read",
        data: { snapshot: current, previousSnapshot: input.snapshot },
      });
    }
    if (input.cursor !== undefined) {
      const named = cursorSnapshot(input.cursor);
      if (named === undefined) throw new McpError("bad-cursor", "The cursor is not one this server gave.", { retryable: false, stage: "read" });
      if (named !== current) {
        throw new McpError("stale-cursor", `The cursor belongs to snapshot ${named}; this session is on ${current}. Re-run the query on the current snapshot.`, {
          retryable: true,
          stage: "read",
          data: { snapshot: current, previousSnapshot: named },
        });
      }
    }
    const result = queryGraph(graph, {
      ...input,
      snapshot: input.snapshot ?? current,
      ...(site.access === undefined ? {} : { access: site.access }),
    } as GraphQueryOptions);
    return json(result as unknown as Record<string, unknown>);
  },
};
