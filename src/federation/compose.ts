/**
 * Composes independent projects' bundles into one federated graph.
 *
 * Two rules keep the result honest. First, every identity is fully qualified with its project and snapshot, so two
 * projects that name the same page stay distinct. Second, a cross-project edge exists only where a bundle declared an
 * explicit reference; nothing is inferred from a matching label. Every list is then sorted by a key that already
 * contains the project and snapshot, so the composed graph and its digest do not depend on the order the bundles were
 * read in.
 *
 * A bundle whose policy the caller may not read is left out whole and never named: not in a node, not in an edge, and
 * not in the missing list, because naming it would disclose a project the caller may not know exists.
 */
import type {
  FederatedCitation,
  FederatedEdge,
  FederatedGraph,
  FederatedNode,
  FederatedNodeKind,
  FederatedUnit,
  FederationMissingBundle,
  FederationRefresh,
  FederationReference,
  KnowledgeBundle,
  LoadedFederation,
} from "../contracts/federation.ts";
import { sha256 } from "../data/lock.ts";
import { canonicalJson } from "../data/lock.ts";
import { byCodePoint, compositionDigest, federatedId } from "./contract.ts";

/** The node kind of one id, read from its `<kind>:` prefix; a bare id is `other`. */
function kindOf(id: string): FederatedNodeKind {
  const colon = id.indexOf(":");
  const prefix = colon === -1 ? "other" : id.slice(0, colon);
  switch (prefix) {
    case "page":
    case "block":
    case "heading":
    case "link":
    case "include":
    case "api":
    case "symbol":
    case "snippet":
    case "collection":
    case "record":
    case "field":
    case "transform":
    case "join":
    case "derived":
    case "claim":
    case "evidence":
    case "check":
    case "lineage":
      return prefix;
    case "surface":
    case "behavior":
    case "test":
    case "project":
    case "snapshot":
      return prefix;
    default:
      return "other";
  }
}

/** The digest of one composed node, so a link that names it can prove it was not rewritten. */
function nodeDigest(project: string, snapshot: string, local: string, label: string): string {
  return sha256(canonicalJson({ project, snapshot, local, label }));
}

/** One citation for a local node of a bundle. */
function citationOf(bundle: KnowledgeBundle, local: string, kind: FederatedNodeKind, label: string, extra: Partial<FederatedCitation> = {}): FederatedCitation {
  return {
    id: federatedId(bundle.project, bundle.snapshot.id, local),
    project: bundle.project,
    namespace: bundle.namespace,
    snapshot: bundle.snapshot.id,
    local,
    kind,
    label,
    ...extra,
    digest: nodeDigest(bundle.project, bundle.snapshot.id, local, label),
  };
}

/** True when the caller may read the bundle's policy. A private bundle with no audiences is readable by nobody. */
export function readable(bundle: KnowledgeBundle, allow: readonly string[] | undefined): boolean {
  if (bundle.policy.public) return true;
  if (allow === undefined) return false;
  return bundle.policy.audiences.length > 0 && bundle.policy.audiences.every((audience) => allow.includes(audience));
}

/** Every bundle the caller may read, by project id. */
export function visibleBundles(loaded: LoadedFederation, allow: readonly string[] | undefined): Map<string, KnowledgeBundle> {
  const out = new Map<string, KnowledgeBundle>();
  for (const project of [...loaded.bundles.keys()].sort(byCodePoint)) {
    const bundle = loaded.bundles.get(project)!;
    if (readable(bundle, allow)) out.set(project, bundle);
  }
  return out;
}

/**
 * The missing bundles to publish. The manifest is the site's own configuration, so a configured project id is named;
 * the reason never quotes a bundle's content, and a bundle that loaded but is unreadable is not named at all, because
 * its project is exactly what the caller may not learn exists.
 */
function visibleMissing(loaded: LoadedFederation, visible: ReadonlyMap<string, KnowledgeBundle>): FederationMissingBundle[] {
  void visible;
  return [...loaded.missing].sort((a, b) => byCodePoint(a.project, b.project));
}

/** One bundle's nodes: its graph nodes, surface items, behaviors, and evidence claims, each qualified. */
export function nodesOf(bundle: KnowledgeBundle): FederatedNode[] {
  const nodes: FederatedNode[] = [];
  for (const node of bundle.graph.nodes) {
    nodes.push({
      citation: citationOf(bundle, node.id, kindOf(node.id), node.label, {
        ...(node.url === undefined ? {} : { url: node.url }),
        ...(node.pos === undefined ? {} : { pos: node.pos }),
        ...(node.knowledge === undefined ? {} : { knowledge: node.knowledge }),
      }),
      ...(node.audience === undefined ? {} : { audience: node.audience }),
      ...(node.knowledge === undefined ? {} : { knowledge: node.knowledge }),
    });
  }
  for (const item of bundle.surface) {
    nodes.push({
      citation: citationOf(bundle, `surface:${item.id}`, "surface", item.name, { ...(item.signature === undefined ? {} : { pos: item.source }) }),
    });
  }
  for (const behavior of bundle.behaviors) {
    nodes.push({
      citation: citationOf(bundle, `behavior:${behavior.id}`, "behavior", behavior.title, { pos: behavior.source, url: behavior.page.url }),
    });
  }
  for (const claim of bundle.evidence.claims) {
    nodes.push({
      citation: citationOf(bundle, `evidence:${claim.id}`, "evidence", claim.subject),
    });
  }
  return nodes;
}

/** The snapshot a reference pins, or the bundle's own when the reference pins none. */
function citedSnapshot(bundle: KnowledgeBundle, target: FederationReference["to"]): string {
  return target.version ?? bundle.snapshot.id;
}

/** One bundle's edges: its own graph edges, then one edge per explicit reference the target resolves. */
export function edgesOf(bundle: KnowledgeBundle, visible: ReadonlyMap<string, KnowledgeBundle>): FederatedEdge[] {
  const edges: FederatedEdge[] = [];
  const locals = new Set(bundle.graph.nodes.map((node) => node.id));
  for (const edge of bundle.graph.edges) {
    edges.push({
      from: federatedId(bundle.project, bundle.snapshot.id, edge.from),
      to: federatedId(bundle.project, bundle.snapshot.id, edge.to),
      kind: edge.kind,
      crossProject: false,
      ...(edge.pos === undefined ? {} : { pos: edge.pos }),
    });
  }
  for (const reference of bundle.references) {
    if (!locals.has(reference.from)) continue;
    const target = visible.get(reference.to.project);
    if (target === undefined) continue;
    const snapshot = citedSnapshot(target, reference.to);
    if (snapshot !== target.snapshot.id) {
      // A reference pinned to another snapshot never resolves to a different one; the query reports it `incompatible`.
      continue;
    }
    const known = target.graph.nodes.some((node) => node.id === reference.to.id)
      || target.surface.some((item) => `surface:${item.id}` === reference.to.id)
      || target.behaviors.some((behavior) => `behavior:${behavior.id}` === reference.to.id)
      || target.evidence.claims.some((claim) => `evidence:${claim.id}` === reference.to.id);
    if (!known) continue;
    edges.push({
      from: federatedId(bundle.project, bundle.snapshot.id, reference.from),
      to: federatedId(target.project, target.snapshot.id, reference.to.id),
      kind: reference.kind,
      crossProject: true,
      ...(reference.digest === undefined ? {} : { digest: reference.digest }),
    });
  }
  return edges;
}

/** One project's contribution to a composed graph, so a refresh can reuse or replace it whole. */
export function unitOf(bundle: KnowledgeBundle, visible: ReadonlyMap<string, KnowledgeBundle>): FederatedUnit {
  return {
    project: bundle.project,
    snapshot: bundle.snapshot.id,
    digest: bundle.digest,
    nodes: nodesOf(bundle),
    edges: edgesOf(bundle, visible),
  };
}

/** Every unit, in project order, so a caller may cache them. */
export function unitsOf(visible: ReadonlyMap<string, KnowledgeBundle>): FederatedUnit[] {
  return [...visible.values()].map((bundle) => unitOf(bundle, visible)).sort((a, b) => byCodePoint(a.project, b.project));
}

/** Sorts nodes by qualified id. */
function sortNodes(nodes: readonly FederatedNode[]): FederatedNode[] {
  return [...nodes].sort((a, b) => byCodePoint(a.citation.id, b.citation.id));
}

/** Sorts edges by source, target, kind, and then the cross-project marker, and collapses exact duplicates. */
function sortEdges(edges: readonly FederatedEdge[]): FederatedEdge[] {
  const sorted = [...edges].sort(
    (a, b) => byCodePoint(a.from, b.from) || byCodePoint(a.to, b.to) || byCodePoint(a.kind, b.kind) || (a.crossProject === b.crossProject ? 0 : a.crossProject ? 1 : -1),
  );
  const out: FederatedEdge[] = [];
  for (const edge of sorted) {
    const previous = out[out.length - 1];
    if (previous !== undefined && previous.from === edge.from && previous.to === edge.to && previous.kind === edge.kind && previous.crossProject === edge.crossProject) {
      continue;
    }
    out.push(edge);
  }
  return out;
}

/** Composes units into a graph. Its digest covers the projects, nodes, and edges, so it is order-independent. */
export function composeUnits(
  units: readonly FederatedUnit[],
  projects: FederatedGraph["projects"],
  missing: readonly FederationMissingBundle[],
  removed: FederatedGraph["removed"] = [],
): FederatedGraph {
  const nodes = sortNodes(units.flatMap((unit) => unit.nodes));
  const known = new Set(nodes.map((node) => node.citation.id));
  const edges = sortEdges(units.flatMap((unit) => unit.edges)).filter((edge) => known.has(edge.from) && known.has(edge.to));
  const body = {
    projects: [...projects].sort((a, b) => byCodePoint(a.id, b.id)),
    nodes,
    edges,
  };
  return {
    version: 1,
    ...body,
    digest: compositionDigest(body),
    removed: [...removed].sort((a, b) => byCodePoint(a.id, b.id)),
    partial: missing.length > 0,
    missing: [...missing],
  };
}

/** The removals of every visible project, by fully qualified id. */
function removedRows(visible: ReadonlyMap<string, KnowledgeBundle>): FederatedGraph["removed"] {
  return [...visible.values()].flatMap((bundle) =>
    bundle.removed.map((entry) => ({
      id: federatedId(bundle.project, bundle.snapshot.id, entry.id),
      project: bundle.project,
      snapshot: bundle.snapshot.id,
      version: entry.version,
    })),
  );
}

/** The project rows of a composed graph, in project order. */
function projectRows(visible: ReadonlyMap<string, KnowledgeBundle>): FederatedGraph["projects"] {
  return [...visible.values()]
    .sort((a, b) => byCodePoint(a.project, b.project))
    .map((bundle) => ({
      id: bundle.project,
      namespace: bundle.namespace,
      role: bundle.role,
      snapshot: bundle.snapshot,
      digest: bundle.digest,
    }));
}

/** Composes every visible bundle into one graph. */
export function composeFederation(loaded: LoadedFederation, options: { readonly allow?: readonly string[] } = {}): FederatedGraph {
  const visible = visibleBundles(loaded, options.allow);
  return composeUnits(unitsOf(visible), projectRows(visible), visibleMissing(loaded, visible), removedRows(visible));
}

/** What a refresh reused, and the graph it recomposed. */
export interface RefreshInput {
  /** The units a previous composition used, by project. */
  readonly previous: readonly FederatedUnit[];
  /** What the caller may read. */
  readonly allow?: readonly string[];
}

/**
 * Recomputes only the units of the projects whose snapshot changed, reuses every other unit whole, and composes the
 * same graph a full composition over the new input would. Because every unit is a pure function of its bundle (and the
 * visible bundles it references), reusing an unchanged unit and recomposing its changed neighbours cannot differ from
 * recomposing everything.
 */
export function refreshFederation(loaded: LoadedFederation, input: RefreshInput): FederationRefresh {
  const visible = visibleBundles(loaded, input.allow);
  const previous = new Map(input.previous.map((unit) => [unit.project, unit]));
  const reused: string[] = [];
  const recomposed: string[] = [];
  const units: FederatedUnit[] = [];
  // A project whose snapshot changed can invalidate a neighbour that references it, so collect the changed digests
  // first and recompute exactly those units and the units that point at them.
  const changed = new Set<string>();
  for (const bundle of visible.values()) {
    const before = previous.get(bundle.project);
    if (before === undefined || before.digest !== bundle.digest || before.snapshot !== bundle.snapshot.id) {
      changed.add(bundle.project);
    }
  }
  for (const bundle of [...visible.values()].sort((a, b) => byCodePoint(a.project, b.project))) {
    const before = previous.get(bundle.project);
    const pointsAtChange = bundle.references.some((reference) => changed.has(reference.to.project));
    if (before !== undefined && !changed.has(bundle.project) && !pointsAtChange) {
      // The unit is a pure function of its bundle and the visible bundles its references resolve against; a reference
      // itself lives in this bundle, so an unchanged bundle that points at no changed project contributes the same
      // nodes and edges it did before, and reusing it whole is exactly what a full recomposition would produce.
      units.push(before);
      reused.push(bundle.project);
      continue;
    }
    units.push(unitOf(bundle, visible));
    recomposed.push(bundle.project);
  }
  return {
    reused,
    recomposed,
    graph: composeUnits(units, projectRows(visible), visibleMissing(loaded, visible), removedRows(visible)),
  };
}
