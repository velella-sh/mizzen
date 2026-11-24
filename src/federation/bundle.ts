/**
 * A published knowledge bundle: one repository's graph, public surface, behavior contracts, and authorized evidence,
 * with the tool version, the snapshot identity, and a digest over the whole body. Building is pure — every input is
 * handed in — and reading verifies the digest, the version, and the shape before any part is used, so a bundle that
 * was edited after it was published is refused whole.
 *
 * Only public data is published: a surface item, behavior, claim, or graph node the policy denies is left out here,
 * never redacted in place, so no private value can reach a bundle, a query, or a pack.
 */
import type {
  FederationEvidenceBundle,
  FederationEvidenceLink,
  FederationPolicy,
  FederationReference,
  FederationRole,
  FederationSnapshot,
  KnowledgeBundle,
} from "../contracts/federation.ts";
import type { BehaviorEvidenceLink, BehaviorRecord, BehaviorTestLink } from "../contracts/behavior.ts";
import type { Graph, GraphKnowledge } from "../contracts/graph.ts";
import type { SurfaceItem } from "../contracts/surface.ts";
import { version } from "../index.ts";
import { byCodePoint, bundleDigest } from "./contract.ts";

/** The bundle file name a project publishes. */
export const BUNDLE_FILE = "knowledge.bundle.json";

/** What a bundle build reads, so it never opens disk itself. */
export interface BundleInput {
  readonly project: string;
  readonly namespace: string;
  readonly role: FederationRole;
  readonly snapshot: FederationSnapshot;
  readonly policy: FederationPolicy;
  readonly graph: Graph;
  readonly surface: readonly SurfaceItem[];
  readonly behaviors: readonly BehaviorRecord[];
  readonly evidence: FederationEvidenceBundle;
  readonly references: readonly FederationReference[];
  readonly removed: readonly { readonly id: string; readonly version: string }[];
}

/** One node's audience, when a graph node carries one that the policy does not publish. */
function allowed(audiences: readonly string[] | undefined, policy: FederationPolicy): boolean {
  if (audiences === undefined || audiences.length === 0) return policy.public;
  return audiences.every((audience) => policy.audiences.includes(audience));
}

/** The graph with every node and edge the policy does not publish left out whole. */
function publicGraph(graph: Graph, policy: FederationPolicy): Graph {
  const nodes = graph.nodes.filter((node) => allowed(node.audience, policy));
  const ids = new Set(nodes.map((node) => node.id));
  const edges = graph.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
  return { ...graph, nodes, edges };
}

/** A behavior whose declaration is public, and whose private evidence values are dropped rather than redacted. */
function publicBehavior(behavior: BehaviorRecord): BehaviorRecord | undefined {
  if (behavior.source === undefined) return undefined;
  const tests = behavior.tests.map((test): BehaviorTestLink => {
    if (test.redacted !== true) return test;
    const { name: _name, ...rest } = test;
    return { ...rest };
  });
  const evidence = behavior.evidence.map((entry): BehaviorEvidenceLink => {
    if (entry.redacted !== true) return entry;
    return { kind: entry.kind, state: entry.state, ...(entry.digest === undefined ? {} : { digest: entry.digest }) };
  });
  return { ...behavior, tests, evidence };
}

/** Sorts a list of links by source, target project, target, and kind, so an input order never reaches the digest. */
function sortLinks(links: readonly FederationEvidenceLink[]): FederationEvidenceLink[] {
  return [...links].sort(
    (a, b) =>
      byCodePoint(a.from, b.from) ||
      byCodePoint(a.target?.project ?? "", b.target?.project ?? "") ||
      byCodePoint(a.to, b.to) ||
      byCodePoint(a.kind, b.kind) ||
      byCodePoint(a.digest, b.digest),
  );
}

/** Sorts references by source, target project, target id, and kind. */
function sortReferences(references: readonly FederationReference[]): FederationReference[] {
  return [...references].sort(
    (a, b) =>
      byCodePoint(a.from, b.from) ||
      byCodePoint(a.to.project, b.to.project) ||
      byCodePoint(a.to.id, b.to.id) ||
      byCodePoint(a.kind, b.kind),
  );
}

/**
 * Builds a bundle: filters private data, sorts every list, and computes the digest over the body. The same input gives
 * byte-identical output whatever order the lists arrived in.
 */
export function buildBundle(input: BundleInput): KnowledgeBundle {
  const graph = publicGraph(input.graph, input.policy);
  const behaviors = input.behaviors
    .filter((behavior) => behavior.id !== "")
    .map(publicBehavior)
    .filter((behavior): behavior is BehaviorRecord => behavior !== undefined)
    .sort((a, b) => byCodePoint(a.id, b.id));
  const surface = input.surface
    .filter((item) => item.id !== "")
    .sort((a, b) => byCodePoint(a.area, b.area) || byCodePoint(a.id, b.id));
  const evidence: FederationEvidenceBundle = {
    version: 1,
    claims: input.evidence.claims
      .map((claim) => ({ id: claim.id, subject: claim.subject, evidence: [...claim.evidence].sort(byCodePoint) }))
      .sort((a, b) => byCodePoint(a.id, b.id)),
    links: sortLinks(input.evidence.links),
  };
  const removed = [...input.removed].sort((a, b) => byCodePoint(a.id, b.id) || a.version < b.version ? -1 : a.version > b.version ? 1 : 0);
  const body: Omit<KnowledgeBundle, "digest"> = {
    version: 1,
    tool: version,
    project: input.project,
    namespace: input.namespace,
    role: input.role,
    snapshot: input.snapshot,
    policy: { public: input.policy.public, audiences: [...input.policy.audiences].sort(byCodePoint) },
    graph,
    surface,
    behaviors,
    evidence,
    references: sortReferences(input.references),
    removed,
  };
  return { ...body, digest: bundleDigest(body) };
}

/** The bundle text a project publishes: two-space JSON and one trailing LF. */
export function bundleText(bundle: KnowledgeBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

/** A read bundle, or every reason it was refused. */
export interface BundleRead {
  readonly bundle?: KnowledgeBundle;
  readonly problem?: string;
}

/** True for a plain JSON object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when `value` has the shape a graph needs, without validating every node against the graph schema. */
function isGraph(value: unknown): value is Graph {
  if (!isObject(value)) return false;
  return (
    value.format === 1 &&
    isObject(value.snapshot) &&
    typeof value.snapshot.id === "string" &&
    Array.isArray(value.nodes) &&
    Array.isArray(value.edges)
  );
}

/** The node kinds a federated citation may carry, so an unknown kind never reaches a query. */
function isEvidenceBundle(value: unknown): value is FederationEvidenceBundle {
  if (!isObject(value) || value.version !== 1) return false;
  if (!Array.isArray(value.claims) || !Array.isArray(value.links)) return false;
  return value.links.every(
    (link) =>
      isObject(link) &&
      typeof link.from === "string" &&
      typeof link.to === "string" &&
      typeof link.kind === "string" &&
      typeof link.digest === "string",
  );
}

/**
 * Reads and verifies a bundle. The digest must match the body, the version must be one this engine reads, and every
 * part must have its shape; any failure returns the reason and no bundle, so a caller never uses a partial one.
 */
export function readBundle(value: unknown): BundleRead {
  if (!isObject(value)) return { problem: "a bundle must be a JSON object" };
  if (value.version !== 1) return { problem: `the bundle version must be 1, not ${String(value.version)}` };
  if (typeof value.project !== "string" || value.project === "") return { problem: "the bundle names no project" };
  if (typeof value.namespace !== "string" || value.namespace === "") return { problem: "the bundle names no namespace" };
  if (value.role !== "product" && value.role !== "docs" && value.role !== "consumer") {
    return { problem: "the bundle names no known role" };
  }
  if (!isObject(value.snapshot) || typeof value.snapshot.id !== "string" || typeof value.snapshot.version !== "string") {
    return { problem: "the bundle names no snapshot identity" };
  }
  if (!isObject(value.policy) || typeof value.policy.public !== "boolean" || !Array.isArray(value.policy.audiences)) {
    return { problem: "the bundle names no access policy" };
  }
  if (!isGraph(value.graph)) return { problem: "the bundle's graph is not a graph" };
  if (!Array.isArray(value.surface)) return { problem: "the bundle's surface is not a list" };
  if (!Array.isArray(value.behaviors)) return { problem: "the bundle's behaviors are not a list" };
  if (!isEvidenceBundle(value.evidence)) return { problem: "the bundle's evidence is not a bundle" };
  if (!Array.isArray(value.references)) return { problem: "the bundle's references are not a list" };
  if (!Array.isArray(value.removed)) return { problem: "the bundle's removed nodes are not a list" };
  if (typeof value.digest !== "string") return { problem: "the bundle carries no digest" };

  const bundle = value as unknown as KnowledgeBundle;
  const actual = bundleDigest(bundle);
  if (actual !== bundle.digest) {
    return { problem: `the bundle's digest is ${bundle.digest}, but its body hashes to ${actual}` };
  }
  return { bundle };
}

/** The knowledge a bundle's graph node carries, for a composed node; `undefined` when it declares none. */
export function knowledgeOfNode(bundle: KnowledgeBundle, local: string): GraphKnowledge | undefined {
  return bundle.graph.nodes.find((node) => node.id === local)?.knowledge;
}
