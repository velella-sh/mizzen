/**
 * `mizzen graph [dir]`: answers one query against the current knowledge-graph snapshot. It builds the model, reads the
 * links, includes, code references, and symbols the graph needs, and prints the same JSON the `query_graph` MCP tool
 * returns: the node's status, its bounded neighbors, the shortest path to `--to`, a `partial` marker and `--cursor`
 * when a bound stopped the answer.
 */
import { resolve } from "node:path";
import { buildGraph } from "../graph/build.ts";
import { collectGraphInput } from "../graph/collect.ts";
import { queryGraph, type GraphDirection, type GraphQueryOptions } from "../graph/query.ts";
import type { GraphEdgeKind } from "../contracts/index.ts";
import { buildModel } from "../model/build.ts";

/** Where the command prints. */
export interface GraphIo {
  readonly log: (message: string) => void;
  readonly error: (message: string) => void;
}

export const graphUsage = `Usage: mizzen graph [dir] [options]

  --snapshot <id>      Read this snapshot (default: the snapshot this build makes)
  --from <id>          The node to start from, such as page:guide.md
  --to <id>            The node to reach, for the shortest path
  --depth <n>          Longest path from --from (default: 3, at most 32)
  --nodes <n>          Most nodes in the neighbor answer (default: 100, at most 1000)
  --max-output <n>     Most characters in the neighbor answer (default: 100000)
  --cursor <text>      Continue a partial answer
  --direction <out|in|both>  Which way edges are followed (default: out)
  --kinds <a,b>        Edge kinds to follow
  --allow <a,b>        Audiences the caller may read; without it only public nodes are visible
  --scope <k:v,...>    The scope to ask about, such as platform:windows; a declaration that does not cover it is not definitive
  --json               Print JSON (the only format)
`;

interface GraphArgs {
  readonly root: string;
  readonly options: Omit<GraphQueryOptions, "previous">;
}

/** Parses the command's arguments. */
function parseGraph(args: readonly string[]): GraphArgs | { readonly error: string } {
  let root = ".";
  const options: { -readonly [K in keyof Omit<GraphQueryOptions, "previous">]: Omit<GraphQueryOptions, "previous">[K] } = {};
  const list = (value: string): string[] => value.split(",").map((item) => item.trim()).filter((item) => item !== "");
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "-h" || arg === "--help") return { error: "" };
    if (arg === "--json") continue;
    if (arg.startsWith("-")) {
      const next = args[++index];
      if (next === undefined || next.startsWith("-")) return { error: `${arg} needs a value` };
      if (arg === "--snapshot") options.snapshot = next;
      else if (arg === "--from") options.from = next;
      else if (arg === "--to") options.to = next;
      else if (arg === "--cursor") options.cursor = next;
      else if (arg === "--allow") options.allow = list(next);
      else if (arg === "--scope") {
        const scope = list(next).map((entry) => {
          const at = entry.indexOf(":");
          return at <= 0 ? undefined : { kind: entry.slice(0, at).trim() as "surface" | "behavior" | "platform" | "version", value: entry.slice(at + 1).trim() };
        });
        if (scope.some((entry) => entry === undefined || entry.value === "")) return { error: "--scope needs kind:value pairs such as platform:windows" };
        options.scope = scope as { kind: "surface" | "behavior" | "platform" | "version"; value: string }[];
      }
      else if (arg === "--kinds") options.kinds = list(next) as GraphEdgeKind[];
      else if (arg === "--direction") {
        if (next !== "out" && next !== "in" && next !== "both") return { error: "--direction must be out, in, or both" };
        options.direction = next as GraphDirection;
      } else if (arg === "--depth" || arg === "--nodes" || arg === "--max-output") {
        const value = Number(next);
        if (!Number.isInteger(value) || value < 0) return { error: `${arg} needs a whole number` };
        if (arg === "--depth") options.depth = value;
        else if (arg === "--nodes") options.nodes = value;
        else options.maxOutput = value;
      } else return { error: `unknown option: ${arg}` };
    } else if (root === ".") root = arg;
    else return { error: `unexpected argument: ${arg}` };
  }
  return { root, options };
}

/** Runs `mizzen graph`; returns the exit code. */
export async function runGraph(args: readonly string[], io: GraphIo): Promise<number> {
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    io.log(`${graphUsage.replace(/\n$/, "")}\n`);
    return 0;
  }
  const parsed = parseGraph(args);
  if ("error" in parsed) {
    if (parsed.error === "") {
      io.log(`${graphUsage.replace(/\n$/, "")}\n`);
      return 0;
    }
    io.error(`mizzen: ${parsed.error}\n\n${graphUsage}`);
    return 2;
  }
  const root = resolve(parsed.root);
  const { site } = await buildModel(root);
  const input = await collectGraphInput({ root, site });
  const { graph, diagnostics } = buildGraph(input);
  for (const problem of diagnostics) {
    if (problem.severity === "error") io.error(`${problem.code}: ${problem.message}`);
  }
  const result = queryGraph(graph, { ...parsed.options, snapshot: parsed.options.snapshot ?? graph.snapshot.id });
  io.log(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}
