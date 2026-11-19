/**
 * Entry-point selection and dependency closure over the knowledge graph.
 *
 * Scope references pick pages, blocks, records, collections, symbols, and files directly, with the
 * reason that selected each. The task goal contributes ranked pages only when the scope names none
 * or leaves a gap, and never a page that matches no term. From those entries the closure follows
 * links, includes, data renders, API documents, symbol references, and acceptance checks outwards
 * to a depth and node cap; a cycle is reported and rejected instead of walked forever, and a node
 * reached past the cap is a scope omission rather than silent content.
 */
import type { Graph, GraphEdge, GraphNode, Site, TaskContract } from "../contracts/index.ts";
import { buildGraph, pageNodeId } from "../graph/build.ts";
import { collectGraphInput } from "../graph/collect.ts";
import { queryGraph } from "../graph/query.ts";
import { rankPages } from "../packs/rank.ts";
import type { ContextDependency, ContextEntry, ContextEntryKind, ContextOmission } from "./types.ts";

/** The default longest dependency path. */
export const DEFAULT_CONTEXT_DEPTH = 3;

/** The default most nodes one selection may hold, entry points included. */
export const DEFAULT_CONTEXT_NODES = 48;

/** How a selection reads its graph. */
export interface SelectOptions {
  /** A graph the caller already built; without it the site's structural graph is built here. */
  readonly graph?: Graph;
  /** The site root, so links, includes, code references, and symbols can be collected. */
  readonly root?: string;
  /** Longest dependency path; default 3. */
  readonly maxDepth?: number;
  /** Most nodes the selection may hold; default 48. */
  readonly maxNodes?: number;
  /** Audiences the task may read; without it, public nodes only. */
  readonly allow?: readonly string[];
}

/** One selection: entries, the edges the closure followed, what it refused, and the graph it read. */
export interface ContextSelection {
  readonly graph: Graph;
  readonly entries: readonly ContextEntry[];
  readonly dependencies: readonly ContextDependency[];
  readonly omitted: readonly ContextOmission[];
  /** Every cycle found in the selected subgraph, as node ids from the repeated node back to itself. */
  readonly cycles: readonly (readonly string[])[];
}

/** Node kinds that name content a pack can carry; the rest are structure or already in a page. */
const CONTENT_KINDS: Readonly<Record<string, ContextEntryKind | undefined>> = {
  page: "page",
  block: "block",
  record: "record",
  collection: "collection",
  symbol: "symbol",
  include: "include",
  api: "api",
  check: "check",
  lineage: "lineage",
  evidence: "evidence",
  field: "field",
};

/** The reason code for one edge kind. */
function reasonOf(edge: string): string {
  switch (edge) {
    case "links":
    case "targets":
      return "dependency.link";
    case "includes":
      return "dependency.include";
    case "documents":
      return "dependency.api";
    case "renders":
    case "asserts":
    case "backs":
    case "derives":
    case "reads":
    case "writes":
    case "joins":
      return "dependency.data";
    case "references":
      return "dependency.symbol";
    case "checks":
      return "dependency.acceptance";
    default:
      return "dependency.contains";
  }
}

/** A graph node's pack kind, or `undefined` when it is structure a fragment already carries. */
export function entryKindOf(node: GraphNode): ContextEntryKind | undefined {
  return CONTENT_KINDS[node.kind];
}

/** The graph the selection reads: the caller's, a collected one when a root is known, else the structural one. */
export async function contextGraphOf(site: Site, options: SelectOptions = {}): Promise<Graph> {
  if (options.graph !== undefined) return options.graph;
  if (options.root !== undefined) {
    const collected = await collectGraphInput({ root: options.root, site });
    return buildGraph(collected).graph;
  }
  return buildGraph({ site }).graph;
}

/** Compares strings by code point. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A page node id for a scope reference written as a URL or source path, or `undefined`. */
function pageNodeFor(site: Site, ref: string): string | undefined {
  const value = ref.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (value === "") return undefined;
  const page = site.pages.find((candidate) => {
    const source = candidate.source.file.replace(/\\/g, "/").replace(/^\/+/, "");
    const url = candidate.url.replace(/^\/+|\/+$/g, "");
    return source === value || url === value || source.endsWith(`/${value}`) || url.endsWith(`/${value}`);
  });
  return page === undefined ? undefined : pageNodeId(page);
}

/** The node a scope reference names, in the scope kind's own order of confidence. */
export function resolveRef(graph: Graph, site: Site, ref: string, kind: string): GraphNode | undefined {
  const value = ref.trim().replace(/\\/g, "/");
  if (value === "") return undefined;
  const nodes = graph.nodes;
  const byId = nodes.find((node) => node.id === value);
  if (byId !== undefined && entryKindOf(byId) !== undefined) return byId;

  if (kind === "pages" || kind === "files" || kind === "blocks") {
    const pageId = pageNodeFor(site, value);
    const pageNode = pageId === undefined ? undefined : nodes.find((node) => node.id === pageId);
    if (pageNode !== undefined) return pageNode;
  }
  if (kind === "blocks") {
    const block = nodes.find((node) => node.kind === "block" && (node.id === `block:${value}` || node.label === value));
    if (block !== undefined) return block;
  }
  if (kind === "collections") {
    const collection = nodes.find((node) => node.kind === "collection" && (node.id === `collection:${value}` || node.label === value));
    if (collection !== undefined) return collection;
  }
  if (kind === "records") {
    const record = nodes.find(
      (node) =>
        node.kind === "record" &&
        (node.id === `record:${value}` || node.id.endsWith(`/${value}`) || node.label === value),
    );
    if (record !== undefined) return record;
  }
  if (kind === "symbols") {
    const symbol = nodes.find(
      (node) => node.kind === "symbol" && (node.label === value || node.id === `symbol:${value}` || node.id.endsWith(`#${value}`)),
    );
    if (symbol !== undefined) return symbol;
  }
  return undefined;
}

/** The entry for one node, with the reason and readable label. */
function entryOf(node: GraphNode, reason: string): ContextEntry {
  return {
    id: node.id,
    kind: entryKindOf(node) ?? "page",
    label: node.label,
    reason,
    ...(node.pos === undefined ? {} : { pos: node.pos }),
    ...(node.url === undefined ? {} : { url: node.url }),
  };
}

/** The entry points the task names directly, in scope order, plus the pages the goal ranks. */
function entriesOf(graph: Graph, site: Site, task: TaskContract, omitted: ContextOmission[]): ContextEntry[] {
  const entries: ContextEntry[] = [];
  const seen = new Set<string>();
  const add = (node: GraphNode, reason: string): void => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    entries.push(entryOf(node, reason));
  };

  const scopeKinds: readonly (readonly [string, readonly string[]])[] = [
    ["pages", task.scope.pages],
    ["blocks", task.scope.blocks],
    ["collections", task.scope.collections],
    ["symbols", task.scope.symbols],
    ["files", task.scope.files],
  ];
  for (const [kind, refs] of scopeKinds) {
    for (const ref of refs) {
      const node = resolveRef(graph, site, ref, kind);
      if (node === undefined) {
        omitted.push({
          ref,
          kind: kind === "pages" ? "page" : kind === "blocks" ? "block" : kind === "collections" ? "collection" : kind === "symbols" ? "symbol" : "file",
          reason: "scope",
          detail: `The task scope names \`${ref}\`, which this build has no ${kind.slice(0, -1)} for.`,
        });
        continue;
      }
      add(node, `scope.${kind.slice(0, -1)}`);
    }
  }

  // A review criterion points at the check result the pack must contain; without a check node the
  // answerability pass reports the missing evidence instead of inventing a page.
  for (const criterion of task.acceptance) {
    if (criterion.check === undefined) continue;
    const node = graph.nodes.find((candidate) => candidate.id === `check:${criterion.check}`);
    if (node !== undefined) add(node, "acceptance.check");
  }

  const docs = site.pages.filter((page) => page.kind === "doc");
  const ranked = rankPages(docs, task.goal, { base: site.config.base, ...(task.goal === "" ? {} : {}) });
  for (const entry of ranked) {
    if (entry.score <= 0) break;
    const node = graph.nodes.find((candidate) => candidate.id === pageNodeId(entry.page));
    if (node === undefined) continue;
    add(node, "goal.match");
    if (entries.length >= DEFAULT_CONTEXT_NODES) break;
  }
  return entries;
}

/** One node reached by the closure, with the edge that reached it. */
interface Reached {
  readonly node: GraphNode;
  readonly edge: GraphEdge;
}

/** The nodes one BFS reaches from one start, in query order, bounded by `nodes` and `depth`. */
function neighborsOf(graph: Graph, start: GraphNode, options: SelectOptions, nodes: number): readonly Reached[] {
  const result = queryGraph(graph, {
    from: start.id,
    direction: "out",
    depth: options.maxDepth ?? DEFAULT_CONTEXT_DEPTH,
    nodes,
    ...(options.allow === undefined ? {} : { allow: options.allow }),
  });
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const reached: Reached[] = [];
  for (const neighbor of result.neighbors) {
    const node = byId.get(neighbor.node.id);
    if (node === undefined) continue;
    reached.push({
      node,
      edge: {
        from: neighbor.edge.from,
        to: neighbor.edge.to,
        kind: neighbor.edge.kind,
        ...(neighbor.edge.pos === undefined ? {} : { pos: neighbor.edge.pos }),
      },
    });
  }
  return reached;
}

/** Every cycle in the selected subgraph, found by a three-colour depth-first walk. */
function cyclesOf(ids: ReadonlySet<string>, edges: readonly ContextDependency[]): readonly (readonly string[])[] {
  const out = new Map<string, string[]>();
  for (const edge of edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) continue;
    out.set(edge.from, [...(out.get(edge.from) ?? []), edge.to]);
  }
  const colour = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const found: string[][] = [];
  const seen = new Set<string>();

  const visit = (id: string): void => {
    colour.set(id, 1);
    stack.push(id);
    for (const next of out.get(id) ?? []) {
      if (colour.get(next) === 1) {
        const start = stack.indexOf(next);
        if (start !== -1) {
          const cycle = [...stack.slice(start), next];
          const key = cycle.join("\u0000");
          if (!seen.has(key) && found.length < 16) {
            seen.add(key);
            found.push(cycle);
          }
        }
      } else if ((colour.get(next) ?? 0) === 0) {
        visit(next);
      }
    }
    stack.pop();
    colour.set(id, 2);
  };

  for (const id of [...ids].sort(byCodePoint)) {
    if ((colour.get(id) ?? 0) === 0) visit(id);
  }
  return found;
}

/**
 * Selects entry points and closes their dependencies.
 *
 * The entry order is scope order, then acceptance checks, then goal matches. The closure visits
 * each start in that order and follows its edges; a node is added once, with the first edge that
 * reached it. The cap counts entries and dependencies together; a start with no room left is an
 * omission, never a partial answer presented as complete.
 */
export function selectFromGraph(
  graph: Graph,
  site: Site,
  task: TaskContract,
  options: SelectOptions = {},
): ContextSelection {
  const omitted: ContextOmission[] = [];
  const entries = entriesOf(graph, site, task, omitted);
  const maxNodes = Math.max(1, Math.floor(options.maxNodes ?? DEFAULT_CONTEXT_NODES));
  const selected = new Map<string, ContextEntry>(entries.map((entry) => [entry.id, entry]));
  const dependencies: ContextDependency[] = [];
  const edgesSeen = new Set<string>();

  for (const entry of entries) {
    if (selected.size >= maxNodes) {
      omitted.push({
        ref: entry.id,
        kind: entry.kind,
        reason: "scope",
        detail: `The closure stops at ${maxNodes} nodes; widen the task, or raise the closure cap to include \`${entry.label}\`.`,
      });
      continue;
    }
    const node = graph.nodes.find((candidate) => candidate.id === entry.id);
    if (node === undefined) continue;
    for (const reached of neighborsOf(graph, node, options, maxNodes - selected.size)) {
      const kind = entryKindOf(reached.node);
      const edgeKey = `${reached.edge.from}\u0000${reached.edge.to}\u0000${reached.edge.kind}`;
      if (kind === undefined) {
        if (reached.edge.kind !== "contains" && !edgesSeen.has(edgeKey)) {
          edgesSeen.add(edgeKey);
          omitted.push({
            ref: reached.node.id,
            kind: "fragment",
            reason: "irrelevance",
            detail: `\`${reached.node.label}\` is a ${reached.node.kind} node; its text is already carried by the page or fragment that owns it.`,
          });
        }
        continue;
      }
      const dependency: ContextDependency = {
        from: reached.edge.from,
        to: reached.edge.to,
        edge: reached.edge.kind,
        reason: reasonOf(reached.edge.kind),
        ...(reached.edge.pos === undefined ? {} : { pos: reached.edge.pos }),
      };
      if (!selected.has(reached.node.id)) {
        if (selected.size >= maxNodes) {
          omitted.push({
            ref: reached.node.id,
            kind,
            reason: "scope",
            detail: `The closure stops at ${maxNodes} nodes; \`${reached.node.label}\` is reachable through ${dependency.reason} but was not added.`,
          });
          continue;
        }
        selected.set(reached.node.id, entryOf(reached.node, dependency.reason));
      }
      if (!edgesSeen.has(edgeKey)) {
        edgesSeen.add(edgeKey);
        dependencies.push(dependency);
      }
    }
  }

  const cycles = cyclesOf(new Set(selected.keys()), dependencies);
  for (const cycle of cycles) {
    omitted.push({
      ref: cycle.join(" -> "),
      kind: "fragment",
      reason: "scope",
      detail: `The closure rejects a cycle (${cycle.join(" -> ")}); each node appears once, with its first reason.`,
    });
  }

  return {
    graph,
    entries: [...selected.values()],
    dependencies,
    omitted,
    cycles,
  };
}
