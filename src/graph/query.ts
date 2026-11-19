/**
 * Queries one snapshot: the visible neighbors of a node and the shortest path between two nodes, in stable order.
 * Traversal is bounded by depth, node count, and output size. A bounded answer is marked `partial` and carries a
 * cursor that resumes exactly where it stopped; cycles are visited once. Audiences are enforced before traversal, so a
 * hidden node's title, metadata, and edges never reach a result or an omission.
 */
import type {
  Graph,
  GraphArchive,
  GraphEdge,
  GraphEdgeKind,
  GraphNode,
  SourcePos,
} from "../contracts/index.ts";

/** The default neighbor depth. */
export const DEFAULT_QUERY_DEPTH = 3;

/** The most neighbor depth a query accepts. */
export const MAX_QUERY_DEPTH = 32;

/** The default number of nodes one answer may hold. */
export const DEFAULT_QUERY_NODES = 100;

/** The most nodes one answer may hold. */
export const MAX_QUERY_NODES = 1000;

/** The default serialized-size bound, in characters. */
export const DEFAULT_QUERY_OUTPUT = 100_000;

/** Which way edges are followed from the starting node. */
export type GraphDirection = "out" | "in" | "both";

/** One neighbor: the node reached, the edge that reached it, and the direction it was read. */
export interface GraphNeighbor {
  readonly node: GraphNodeSummary;
  readonly edge: Pick<GraphEdge, "from" | "to" | "kind" | "pos">;
  readonly direction: "out" | "in";
}

/** The public part of a node, with no hidden metadata. */
export interface GraphNodeSummary {
  readonly id: string;
  readonly kind: GraphNode["kind"];
  readonly label: string;
  readonly pos?: SourcePos;
  readonly url?: string;
}

/** One step of a path: the node and the edge that led to it, absent on the first step. */
export interface GraphPathStep {
  readonly node: GraphNodeSummary;
  readonly edge?: Pick<GraphEdge, "from" | "to" | "kind" | "pos">;
  readonly direction?: "out" | "in";
}

/** What a query accepts. */
export interface GraphQueryOptions {
  /** The snapshot to read; defaults to the one graph given, and is required for an archive. */
  readonly snapshot?: string;
  /** The node to start from. */
  readonly from?: string;
  /** The node to reach, for the shortest-path half of the answer. */
  readonly to?: string;
  /** Edge kinds to follow; every kind when absent. */
  readonly kinds?: readonly GraphEdgeKind[];
  /** How edges are followed from `from`. Default `out`. */
  readonly direction?: GraphDirection;
  /** Longest path from `from`; default 3, capped at 32. */
  readonly depth?: number;
  /** Most nodes the neighbor answer may hold; default 100, capped at 1000. */
  readonly nodes?: number;
  /** Most characters the neighbor answer may serialize to; default 100000. */
  readonly maxOutput?: number;
  /** Continue an answer this query returned. */
  readonly cursor?: string;
  /** Audiences the caller may read; without it, only public nodes are visible. */
  readonly allow?: readonly string[];
  /** An earlier snapshot, so a missing node is `deleted` rather than `unknown`. */
  readonly previous?: Graph;
}

/** What a query returns. */
export interface GraphQueryResult {
  readonly snapshot: string;
  readonly from?: string;
  /** `present` for a visible start node, `deleted` when `previous` held it, else `unknown`. */
  readonly status: "present" | "deleted" | "unknown";
  readonly neighbors: readonly GraphNeighbor[];
  /** The shortest path from `from` to `to`; absent when no `to` was asked. */
  readonly path?: readonly GraphPathStep[];
  /** True when a path was asked and found. */
  readonly found?: boolean;
  /** True when depth, node, or output bounds stopped the answer. */
  readonly partial: boolean;
  /** Continue with this cursor to read the rest of a bounded answer. */
  readonly cursor?: string;
  /** Why the answer is partial: `nodes` or `output`. */
  readonly reason?: "nodes" | "output";
}

/** Compares strings by code point. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Compares two optional positions, putting an absent one first. */
function comparePos(a: SourcePos | undefined, b: SourcePos | undefined): number {
  if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1;
  return byCodePoint(a.file, b.file) || a.line - b.line || a.column - b.column || a.endLine - b.endLine || a.endColumn - b.endColumn;
}

/** A node's public summary. */
function summaryOf(node: GraphNode): GraphNodeSummary {
  return {
    id: node.id,
    kind: node.kind,
    label: node.label,
    ...(node.pos === undefined ? {} : { pos: node.pos }),
    ...(node.url === undefined ? {} : { url: node.url }),
  };
}

/** True when every audience of the node is allowed; a node without an audience is public. */
function visible(node: GraphNode, allow: readonly string[] | undefined): boolean {
  if (node.audience === undefined || node.audience.length === 0) return true;
  if (allow === undefined) return false;
  return node.audience.every((audience) => allow.includes(audience));
}

/** The graph a query reads, or the one snapshot of an archive it names. */
function snapshotOf(source: Graph | GraphArchive, requested: string | undefined): Graph | undefined {
  if ("snapshots" in source) {
    if (requested === undefined) return undefined;
    return source.snapshots.find((graph) => graph.snapshot.id === requested);
  }
  if (requested !== undefined && requested !== source.snapshot.id) return undefined;
  return source;
}

/** BFS state a cursor carries, so a resumed answer continues the same walk. */
interface CursorState {
  readonly version: 1;
  readonly snapshot: string;
  readonly from: string;
  readonly depth: number;
  readonly nodes: number;
  readonly maxOutput: number;
  readonly fromQueue: readonly { readonly id: string; readonly depth: number }[];
  readonly seen: readonly string[];
  readonly emitted: number;
}

/** Encodes a cursor as opaque text. */
function encodeCursor(state: CursorState): string {
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
}

/** Decodes a cursor, or refuses one that names another snapshot or start. */
function decodeCursor(cursor: string, snapshot: string, from: string): CursorState | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<CursorState>;
    if (parsed.version !== 1 || parsed.snapshot !== snapshot || parsed.from !== from) return undefined;
    if (typeof parsed.depth !== "number" || typeof parsed.nodes !== "number" || typeof parsed.maxOutput !== "number") return undefined;
    if (!Array.isArray(parsed.seen) || !Array.isArray(parsed.fromQueue) || typeof parsed.emitted !== "number") return undefined;
    return parsed as CursorState;
  } catch {
    return undefined;
  }
}

/** The adjacency a query walks: visible edges, sorted by the other end, kind, and position. */
interface Adjacency {
  readonly out: ReadonlyMap<string, readonly GraphEdge[]>;
  readonly into: ReadonlyMap<string, readonly GraphEdge[]>;
}

/** Builds adjacency from the visible nodes and the edges with both ends visible. */
function adjacencyOf(graph: Graph, allow: readonly string[] | undefined, kinds: ReadonlySet<GraphEdgeKind> | undefined): Adjacency {
  const nodes = new Map(graph.nodes.filter((node) => visible(node, allow)).map((node) => [node.id, node] as const));
  const out = new Map<string, GraphEdge[]>();
  const into = new Map<string, GraphEdge[]>();
  const edges = graph.edges.filter(
    (edge) => nodes.has(edge.from) && nodes.has(edge.to) && (kinds === undefined || kinds.has(edge.kind)),
  );
  const compare = (a: GraphEdge, b: GraphEdge, other: (edge: GraphEdge) => string): number =>
    byCodePoint(other(a), other(b)) || byCodePoint(a.kind, b.kind) || comparePos(a.pos, b.pos);
  for (const edge of [...edges].sort((a, b) => compare(a, b, (edge) => edge.to))) {
    out.set(edge.from, [...(out.get(edge.from) ?? []), edge]);
  }
  for (const edge of [...edges].sort((a, b) => compare(a, b, (edge) => edge.from))) {
    into.set(edge.to, [...(into.get(edge.to) ?? []), edge]);
  }
  return { out, into };
}

/** Every neighbor entry of a visited node, in stable order. */
function entriesOf(
  node: string,
  adjacency: Adjacency,
  nodes: ReadonlyMap<string, GraphNode>,
  direction: GraphDirection,
): GraphNeighbor[] {
  const entries: GraphNeighbor[] = [];
  if (direction === "out" || direction === "both") {
    for (const edge of adjacency.out.get(node) ?? []) {
      const target = nodes.get(edge.to);
      if (target === undefined) continue;
      entries.push({ node: summaryOf(target), edge: { from: edge.from, to: edge.to, kind: edge.kind, ...(edge.pos === undefined ? {} : { pos: edge.pos }) }, direction: "out" });
    }
  }
  if (direction === "in" || direction === "both") {
    for (const edge of adjacency.into.get(node) ?? []) {
      const source = nodes.get(edge.from);
      if (source === undefined) continue;
      entries.push({ node: summaryOf(source), edge: { from: edge.from, to: edge.to, kind: edge.kind, ...(edge.pos === undefined ? {} : { pos: edge.pos }) }, direction: "in" });
    }
  }
  return entries;
}

/** The shortest path from `from` to `to`, in stable neighbor order. */
function shortestPath(
  from: string,
  to: string,
  adjacency: Adjacency,
  nodes: ReadonlyMap<string, GraphNode>,
  direction: GraphDirection,
  maxDepth: number,
): GraphPathStep[] | undefined {
  if (from === to) return [{ node: summaryOf(nodes.get(from)!) }];
  const queue: { id: string; depth: number }[] = [{ id: from, depth: 0 }];
  const seen = new Set([from]);
  const parent = new Map<string, { id: string; edge: GraphEdge; direction: "out" | "in" }>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;
    for (const entry of entriesOf(current.id, adjacency, nodes, direction)) {
      if (seen.has(entry.node.id)) continue;
      seen.add(entry.node.id);
      const edge = graphEdgeOf(entry);
      parent.set(entry.node.id, { id: current.id, edge, direction: entry.direction });
      if (entry.node.id === to) {
        const steps: GraphPathStep[] = [{ node: summaryOf(nodes.get(to)!) }];
        let cursor = to;
        while (cursor !== from) {
          const step = parent.get(cursor);
          if (step === undefined) return undefined;
          steps.unshift({ node: summaryOf(nodes.get(step.id)!), edge: step.edge, direction: step.direction });
          cursor = step.id;
        }
        return steps;
      }
      queue.push({ id: entry.node.id, depth: current.depth + 1 });
    }
  }
  return undefined;
}

/** The edge a neighbor entry carries, with its position. */
function graphEdgeOf(entry: GraphNeighbor): GraphEdge {
  return {
    from: entry.edge.from,
    to: entry.edge.to,
    kind: entry.edge.kind,
    ...(entry.edge.pos === undefined ? {} : { pos: entry.edge.pos }),
  };
}

/** The visible start node, if any. */
function startNode(graph: Graph, from: string | undefined, allow: readonly string[] | undefined): GraphNode | undefined {
  if (from === undefined) return undefined;
  return graph.nodes.find((node) => node.id === from && visible(node, allow));
}

/** Whether a previous snapshot held a node that the current one does not. */
export function nodeStatus(current: Graph, id: string, previous?: Graph): "present" | "deleted" | "unknown" {
  if (current.nodes.some((node) => node.id === id)) return "present";
  if (previous?.nodes.some((node) => node.id === id) === true) return "deleted";
  return "unknown";
}

/**
 * Answers one query against one snapshot: the bounded visible neighbors of `from`, and the shortest path from `from`
 * to `to`. A request for another snapshot sees nothing rather than mixing snapshots.
 */
export function queryGraph(source: Graph | GraphArchive, options: GraphQueryOptions): GraphQueryResult {
  const requested = options.snapshot ?? ("snapshots" in source ? undefined : source.snapshot.id);
  const graph = snapshotOf(source, requested);
  const snapshot = requested ?? "";
  if (graph === undefined) {
    return { snapshot, ...(options.from === undefined ? {} : { from: options.from }), status: "unknown", neighbors: [], partial: false, ...(options.to === undefined ? {} : { found: false }) };
  }
  const current = startNode(graph, options.from, options.allow);
  const status = current !== undefined
    ? "present"
    : options.previous === undefined
      ? "unknown"
      : options.from !== undefined && options.previous.nodes.some((node) => node.id === options.from)
        ? "deleted"
        : "unknown";
  if (current === undefined) {
    return { snapshot: graph.snapshot.id, ...(options.from === undefined ? {} : { from: options.from }), status, neighbors: [], partial: false, ...(options.to === undefined ? {} : { found: false }) };
  }

  const depth = Math.max(0, Math.min(MAX_QUERY_DEPTH, options.depth ?? DEFAULT_QUERY_DEPTH));
  const nodeLimit = Math.max(1, Math.min(MAX_QUERY_NODES, options.nodes ?? DEFAULT_QUERY_NODES));
  const maxOutput = Math.max(1, options.maxOutput ?? DEFAULT_QUERY_OUTPUT);
  const direction = options.direction ?? "out";
  const kinds = options.kinds === undefined ? undefined : new Set(options.kinds);
  const adjacency = adjacencyOf(graph, options.allow, kinds);
  const visibleNodes = new Map(graph.nodes.filter((node) => visible(node, options.allow)).map((node) => [node.id, node] as const));

  const decoded = options.cursor === undefined ? undefined : decodeCursor(options.cursor, graph.snapshot.id, current.id);
  const queue = decoded === undefined ? [{ id: current.id, depth: 0 }] : [...decoded.fromQueue];
  const seen = new Set(decoded === undefined ? [current.id] : decoded.seen);
  let nodesTruncated = false;
  while (queue.length > 0) {
    const currentFrame = queue.shift()!;
    if (currentFrame.depth >= depth) continue;
    for (const entry of entriesOf(currentFrame.id, adjacency, visibleNodes, direction)) {
      if (seen.has(entry.node.id)) continue;
      if (seen.size >= nodeLimit) {
        nodesTruncated = true;
        continue;
      }
      seen.add(entry.node.id);
      queue.push({ id: entry.node.id, depth: currentFrame.depth + 1 });
    }
    if (nodesTruncated) break;
  }

  const allEntries: GraphNeighbor[] = [];
  for (const id of seen) {
    allEntries.push(...entriesOf(id, adjacency, visibleNodes, direction));
  }
  const emitted = decoded?.emitted ?? 0;
  const neighbors: GraphNeighbor[] = [];
  let used = 0;
  let outputTruncated = false;
  for (let index = emitted; index < allEntries.length; index++) {
    const entry = allEntries[index]!;
    const size = JSON.stringify(entry).length;
    if (used + size > maxOutput) {
      outputTruncated = true;
      break;
    }
    used += size;
    neighbors.push(entry);
  }

  const partial = outputTruncated || nodesTruncated;
  const cursor =
    (outputTruncated && emitted + neighbors.length < allEntries.length) || (nodesTruncated && queue.length > 0)
      ? encodeCursor({
          version: 1,
          snapshot: graph.snapshot.id,
          from: current.id,
          depth,
          nodes: nodeLimit,
          maxOutput,
          fromQueue: queue,
          seen: [...seen],
          emitted: emitted + neighbors.length,
        })
      : undefined;

  const result: GraphQueryResult = {
    snapshot: graph.snapshot.id,
    from: current.id,
    status,
    neighbors,
    partial,
    ...(partial ? { reason: outputTruncated ? "output" : "nodes" } : {}),
    ...(cursor === undefined ? {} : { cursor }),
  };
  if (options.to !== undefined) {
    const path = shortestPath(current.id, options.to, adjacency, visibleNodes, direction, options.depth === undefined ? MAX_QUERY_DEPTH : depth);
    return { ...result, ...(path === undefined ? { found: false } : { path, found: true }) };
  }
  return result;
}
