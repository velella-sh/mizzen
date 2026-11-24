/**
 * Queries one composed federation: the visible neighbors of a citation and the shortest path between two citations, in
 * stable order. A start may be a fully qualified id or a local id the `project` option qualifies, and every answer
 * returns fully qualified citations, so a caller never has to guess which project a node came from.
 *
 * A project the caller may not read is left out of the composed graph before traversal, so its title, metadata, and
 * edges never reach a result. The answer is `partial` when a bound stopped it or an optional bundle was missing, and
 * `definitive` only when every returned node's knowledge covers the scope the caller asked about.
 */
import type { FederatedCitation, FederatedGraph, FederatedQuery, FederatedQueryResult, FederatedStep } from "../contracts/federation.ts";
import type { KnowledgeScope } from "../contracts/knowledge.ts";
import { scopeCovers } from "../knowledge/parse.ts";
import { byCodePoint } from "./contract.ts";

/** The default neighbor depth. */
export const DEFAULT_FEDERATION_DEPTH = 3;

/** The most neighbor depth a query accepts. */
export const MAX_FEDERATION_DEPTH = 32;

/** The default number of nodes one answer may hold. */
export const DEFAULT_FEDERATION_NODES = 100;

/** The most nodes one answer may hold. */
export const MAX_FEDERATION_NODES = 1000;

/** The citation a start or target option names, or `undefined` when it names none or reads no visible node. */
export function resolveCitation(graph: FederatedGraph, value: string, project?: string): FederatedCitation | undefined {
  const nodes = new Map(graph.nodes.map((node) => [node.citation.id, node.citation] as const));
  if (nodes.has(value)) return nodes.get(value);
  // A local id matches only inside the named project, or, without one, only when exactly one visible project holds it;
  // two same-named nodes from different projects stay distinct.
  const matches = graph.nodes
    .filter((node) => node.citation.local === value && (project === undefined || node.citation.project === project))
    .map((node) => node.citation);
  return matches.length === 1 ? matches[0] : undefined;
}

/** The adjacency a query walks, built from the visible edges. */
interface Adjacency {
  readonly out: ReadonlyMap<string, readonly FederatedGraph["edges"][number][]>;
  readonly into: ReadonlyMap<string, readonly FederatedGraph["edges"][number][]>;
}

/** Builds adjacency from the graph's edges, filtered by kind, in stable order. */
function adjacencyOf(graph: FederatedGraph, kinds: ReadonlySet<string> | undefined): Adjacency {
  const out = new Map<string, FederatedGraph["edges"][number][]>();
  const into = new Map<string, FederatedGraph["edges"][number][]>();
  const edges = graph.edges.filter((edge) => kinds === undefined || kinds.has(edge.kind));
  for (const edge of [...edges].sort((a, b) => byCodePoint(a.to, b.to) || byCodePoint(a.kind, b.kind))) {
    out.set(edge.from, [...(out.get(edge.from) ?? []), edge]);
  }
  for (const edge of [...edges].sort((a, b) => byCodePoint(a.from, b.from) || byCodePoint(a.kind, b.kind))) {
    into.set(edge.to, [...(into.get(edge.to) ?? []), edge]);
  }
  return { out, into };
}

/** The nodes by qualified id. */
function indexOf(graph: FederatedGraph): Map<string, FederatedCitation> {
  return new Map(graph.nodes.map((node) => [node.citation.id, node.citation] as const));
}

/** Every neighbor entry of a visited node, in stable order. */
function entriesOf(
  id: string,
  adjacency: Adjacency,
  nodes: ReadonlyMap<string, FederatedCitation>,
  direction: "out" | "in" | "both",
): { citation: FederatedCitation; edge: FederatedGraph["edges"][number]; direction: "out" | "in" }[] {
  const entries: { citation: FederatedCitation; edge: FederatedGraph["edges"][number]; direction: "out" | "in" }[] = [];
  if (direction === "out" || direction === "both") {
    for (const edge of adjacency.out.get(id) ?? []) {
      const target = nodes.get(edge.to);
      if (target !== undefined) entries.push({ citation: target, edge, direction: "out" });
    }
  }
  if (direction === "in" || direction === "both") {
    for (const edge of adjacency.into.get(id) ?? []) {
      const source = nodes.get(edge.from);
      if (source !== undefined) entries.push({ citation: source, edge, direction: "in" });
    }
  }
  return entries;
}

/** The shortest path from `from` to `to`, in stable neighbor order. */
function shortestPath(
  from: string,
  to: string,
  adjacency: Adjacency,
  nodes: ReadonlyMap<string, FederatedCitation>,
  maxDepth: number,
): FederatedStep[] | undefined {
  if (from === to) return [{ citation: nodes.get(from)! }];
  const queue: { id: string; depth: number }[] = [{ id: from, depth: 0 }];
  const seen = new Set([from]);
  const parent = new Map<string, { id: string; edge: FederatedGraph["edges"][number] }>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;
    for (const entry of entriesOf(current.id, adjacency, nodes, "both")) {
      const id = entry.citation.id;
      if (seen.has(id)) continue;
      seen.add(id);
      parent.set(id, { id: current.id, edge: entry.edge });
      if (id === to) {
        const steps: FederatedStep[] = [{ citation: nodes.get(to)! }];
        let cursor = to;
        while (cursor !== from) {
          const step = parent.get(cursor);
          if (step === undefined) return undefined;
          steps.unshift({ citation: nodes.get(step.id)!, edge: step.edge });
          cursor = step.id;
        }
        return steps;
      }
      queue.push({ id, depth: current.depth + 1 });
    }
  }
  return undefined;
}

/** Whether a node's knowledge is definitive for the query's scope. */
function definitiveOf(citation: FederatedCitation, scope: readonly KnowledgeScope[] | undefined): boolean {
  const knowledge = citation.knowledge;
  if (knowledge === undefined) return true;
  return scopeCovers(knowledge.scope, scope) && knowledge.review !== true;
}

/** True when the start node is one the bundle recorded removing. */
function removedIn(graph: FederatedGraph, id: string): boolean {
  return graph.removed.some((entry) => entry.id === id);
}

/** Every citation in `list` deduplicated and sorted by id. */
function dedupe(list: readonly FederatedCitation[]): FederatedCitation[] {
  const seen = new Map<string, FederatedCitation>();
  for (const citation of list) if (!seen.has(citation.id)) seen.set(citation.id, citation);
  return [...seen.values()].sort((a, b) => byCodePoint(a.id, b.id));
}

/**
 * Answers one cross-repository query. A request for a node the composed graph does not hold sees nothing rather than
 * mixing projects, and a node the caller may not read is `unknown`, exactly as a missing one.
 */
export function queryFederation(graph: FederatedGraph, query: FederatedQuery): FederatedQueryResult {
  const nodes = indexOf(graph);
  const start = query.from === undefined ? undefined : resolveCitation(graph, query.from, query.project);
  const status: FederatedQueryResult["status"] =
    start !== undefined ? "present" : query.from !== undefined && removedIn(graph, query.from) ? "removed" : "unknown";
  const missing = graph.missing;
  const partialBase = graph.partial;

  if (start === undefined) {
    return {
      snapshot: graph.digest,
      status,
      neighbors: [],
      partial: partialBase,
      definitive: true,
      citations: [],
      missing,
    };
  }

  const depth = Math.max(0, Math.min(MAX_FEDERATION_DEPTH, query.depth ?? DEFAULT_FEDERATION_DEPTH));
  const nodeLimit = Math.max(1, Math.min(MAX_FEDERATION_NODES, query.nodes ?? DEFAULT_FEDERATION_NODES));
  const kinds = query.kinds === undefined ? undefined : new Set(query.kinds);
  const adjacency = adjacencyOf(graph, kinds);

  const queue: { id: string; depth: number }[] = [{ id: start.id, depth: 0 }];
  const seen = new Set([start.id]);
  let truncated = false;
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= depth) continue;
    for (const entry of entriesOf(current.id, adjacency, nodes, "out")) {
      if (seen.has(entry.citation.id)) continue;
      if (seen.size >= nodeLimit) {
        truncated = true;
        continue;
      }
      seen.add(entry.citation.id);
      queue.push({ id: entry.citation.id, depth: current.depth + 1 });
    }
    if (truncated) break;
  }

  const neighbors: { citation: FederatedCitation; edge: FederatedGraph["edges"][number]; direction: "out" | "in" }[] = [];
  const found: { citation: FederatedCitation; edge: FederatedGraph["edges"][number]; direction: "out" | "in" }[] = [];
  for (const id of seen) {
    found.push(...entriesOf(id, adjacency, nodes, "out"));
  }
  found.sort(
    (a, b) =>
      byCodePoint(a.citation.id, b.citation.id) ||
      byCodePoint(a.edge.from, b.edge.from) ||
      byCodePoint(a.edge.to, b.edge.to) ||
      byCodePoint(a.edge.kind, b.edge.kind),
  );
  for (const entry of found) {
    neighbors.push({ citation: entry.citation, edge: entry.edge, direction: entry.direction });
  }

  const reached = dedupe([start, ...neighbors.map((entry) => entry.citation)]);
  const definitive = reached.every((citation) => definitiveOf(citation, query.scope));
  const partial = partialBase || truncated;

  const result: FederatedQueryResult = {
    snapshot: graph.digest,
    from: start,
    status,
    neighbors,
    partial,
    definitive,
    citations: reached,
    missing,
  };

  if (query.to !== undefined) {
    const target = resolveCitation(graph, query.to, query.project);
    const path =
      target === undefined ? undefined : shortestPath(start.id, target.id, adjacency, nodes, query.depth === undefined ? MAX_FEDERATION_DEPTH : depth);
    return { ...result, ...(path === undefined ? { found: false } : { path, found: true }) };
  }
  return result;
}
