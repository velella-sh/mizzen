/**
 * Traces an evidence chain across projects: a claim in one project leads, through its own links, to a test or a data
 * node in another project, and every link's digest is preserved and re-verified rather than rewritten.
 *
 * The chain starts at a claim a bundle publishes. Each step follows a link whose source is the current node, in stable
 * order. A target that is missing ends the branch; a link whose digest no longer matches its target is carried into the
 * result with `verified: false` and not followed, so a tampered link is visible instead of silently walked.
 */
import type {
  EvidenceChain,
  EvidenceChainLink,
  FederatedGraph,
  FederatedNodeKind,
  KnowledgeBundle,
  LoadedFederation,
} from "../contracts/federation.ts";
import { byCodePoint, evidenceDigest, federatedId } from "./contract.ts";

/** The most links one chain may follow, so a cyclic reference still terminates. */
export const MAX_CHAIN_LINKS = 64;

/** True when an id exists in a bundle, so a target never resolves to nothing. */
function known(bundle: KnowledgeBundle, local: string): boolean {
  return (
    bundle.graph.nodes.some((node) => node.id === local) ||
    bundle.evidence.claims.some((claim) => claim.id === local || claim.subject === local) ||
    bundle.surface.some((item) => `surface:${item.id}` === local) ||
    bundle.behaviors.some((behavior) => `behavior:${behavior.id}` === local)
  );
}

/** The kind and label of a local id, so a citation names what it is. */
function kindOf(bundle: KnowledgeBundle, local: string): { readonly kind: FederatedNodeKind; readonly label: string } {
  const claim = bundle.evidence.claims.find((entry) => entry.id === local || entry.subject === local);
  if (claim !== undefined) return { kind: "evidence", label: claim.subject };
  const behavior = bundle.behaviors.find((entry) => `behavior:${entry.id}` === local || entry.id === local);
  if (behavior !== undefined) return { kind: "behavior", label: behavior.title };
  const node = bundle.graph.nodes.find((entry) => entry.id === local);
  if (node !== undefined) return { kind: "page", label: node.label };
  const surface = bundle.surface.find((item) => `surface:${item.id}` === local);
  if (surface !== undefined) return { kind: "surface", label: surface.name };
  return { kind: "other", label: local };
}

/** One place a bundle's evidence links a source to a target. */
interface LocalLink {
  readonly from: string;
  readonly to: string;
  readonly kind: string;
  readonly digest: string;
}

/** Every link of every visible bundle, keyed by fully qualified source. */
function linkIndex(loaded: LoadedFederation): Map<string, LocalLink[]> {
  const index = new Map<string, LocalLink[]>();
  for (const bundle of [...loaded.bundles.values()].sort((a, b) => byCodePoint(a.project, b.project))) {
    for (const link of bundle.evidence.links) {
      const target = link.target === undefined ? bundle : loaded.bundles.get(link.target.project);
      if (target === undefined) continue;
      if (link.target?.version !== undefined && link.target.version !== target.snapshot.version) continue;
      const from = federatedId(bundle.project, bundle.snapshot.id, link.from);
      const entry: LocalLink = {
        from,
        to: federatedId(target.project, target.snapshot.id, link.to),
        kind: link.kind,
        digest: link.digest,
      };
      index.set(from, [...(index.get(from) ?? []), entry]);
    }
  }
  for (const links of index.values()) {
    links.sort((a, b) => byCodePoint(a.to, b.to) || byCodePoint(a.kind, b.kind));
  }
  return index;
}

/** One fully qualified id's bundle and local id, or `undefined` when no visible bundle holds it. */
export function locate(loaded: LoadedFederation, id: string): { readonly bundle: KnowledgeBundle; readonly local: string } | undefined {
  const first = id.indexOf("/");
  const second = id.indexOf("/", first + 1);
  if (first <= 0 || second <= first + 1) return undefined;
  const project = id.slice(0, first);
  const bundle = loaded.bundles.get(project);
  if (bundle === undefined) return undefined;
  if (bundle.snapshot.id !== id.slice(first + 1, second)) return undefined;
  return { bundle, local: id.slice(second + 1) };
}

/** One citation for a bundle's local id. */
function citationOf(bundle: KnowledgeBundle, local: string, kind: FederatedNodeKind, label: string): EvidenceChainLink["from"] {
  return {
    id: federatedId(bundle.project, bundle.snapshot.id, local),
    project: bundle.project,
    namespace: bundle.namespace,
    snapshot: bundle.snapshot.id,
    local,
    kind,
    label,
  };
}

/**
 * Follows a claim's evidence chain across projects. A link's digest is checked against the target's own; the link is
 * carried into the result unchanged with `verified` saying whether it matched, and only a verified link is followed.
 */
export function traceEvidenceChain(graph: FederatedGraph, loaded: LoadedFederation, start: string, project?: string): EvidenceChain {
  const qualified = project !== undefined && !start.includes("/")
    ? (loaded.bundles.get(project) === undefined ? start : federatedId(project, loaded.bundles.get(project)!.snapshot.id, start))
    : start;
  const startLocation = locate(loaded, qualified);
  const claimCitation = startLocation === undefined
    ? undefined
    : (() => {
        const claim = startLocation.bundle.evidence.claims.find((entry) => entry.id === startLocation.local || entry.subject === startLocation.local);
        return claim === undefined ? undefined : citationOf(startLocation.bundle, claim.id, "evidence", claim.subject);
      })();
  const visible = graph.projects.some((entry) => entry.id === startLocation?.bundle.project);
  if (claimCitation === undefined || !visible) {
    return {
      version: 1,
      claim: claimCitation ?? {
        id: qualified,
        project: project ?? "",
        namespace: "",
        snapshot: "",
        local: start,
        kind: "evidence",
        label: start,
      },
      links: [],
      reached: [],
      complete: false,
      missing: loaded.missing,
    };
  }

  const index = linkIndex(loaded);
  const links: EvidenceChainLink[] = [];
  const reached = new Map<string, EvidenceChainLink["to"]>();
  const queue: string[] = [claimCitation.id];
  const seen = new Set([claimCitation.id]);
  while (queue.length > 0 && links.length < MAX_CHAIN_LINKS) {
    const current = queue.shift()!;
    const source = locate(loaded, current);
    if (source === undefined) continue;
    for (const link of index.get(current) ?? []) {
      if (seen.has(link.to)) continue;
      const target = locate(loaded, link.to);
      if (target === undefined) continue;
      seen.add(link.to);
      const verified = evidenceDigest(target.bundle.project, target.bundle.snapshot.id, target.local) === link.digest;
      const described = kindOf(target.bundle, target.local);
      const fromKind = kindOf(source.bundle, source.local);
      const citation = citationOf(target.bundle, target.local, known(target.bundle, target.local) ? described.kind : "other", described.label);
      links.push({
        from: citationOf(source.bundle, source.local, fromKind.kind, fromKind.label),
        to: citation,
        kind: link.kind,
        digest: link.digest,
        verified,
      });
      reached.set(citation.id, citation);
      if (verified) queue.push(link.to);
    }
  }

  const crossProject = links.some((link) => link.from.project !== link.to.project);
  return {
    version: 1,
    claim: claimCitation,
    links,
    reached: [...reached.values()].sort((a, b) => byCodePoint(a.id, b.id)),
    complete: links.length > 0 && links.every((link) => link.verified) && loaded.missing.length === 0 && crossProject,
    missing: loaded.missing,
  };
}
