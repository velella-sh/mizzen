/**
 * Federated knowledge across repositories: a versioned manifest names the projects, their namespaces, the role their
 * snapshot plays, and where each one publishes its locked bundle. A published bundle is one repository's graph, public
 * surface, behavior contracts, and authorized evidence, with the tool version, the snapshot identity, and a digest. A
 * build reads only the locally locked copies, so it is offline and repeatable; a fetch writes them, and a missing
 * optional bundle makes every answer `partial` without discarding a snapshot that was already known good.
 *
 * Every identity is fully qualified — project, snapshot, and the node's own id — so two projects that name the same
 * page or the same behavior stay distinct. Cross-project edges exist only where a bundle declares an explicit
 * reference; nothing is inferred from a matching label. A query, a pack, and a bundle obey one access policy, and a
 * project the caller may not read is left out of both the result and the omission it would have produced, so its name
 * never leaks.
 */
import type { BehaviorRecord } from "./behavior.ts";
import type { Graph, GraphKnowledge, GraphNodeKind } from "./graph.ts";
import type { KnowledgeScope } from "./knowledge.ts";
import type { SourcePos } from "./source.ts";
import type { SurfaceItem } from "./surface.ts";

/** The federation contract version this engine writes and reads. */
export type FederationVersion = 1;

/** The role a project's snapshot plays in the federation. */
export type FederationRole = "product" | "docs" | "consumer";

/** Where one project publishes its bundle: an `https:` URL, or a path relative to the manifest. */
export interface FederationSource {
  /** An `https:` address the fetch command may read. */
  readonly url?: string;
  /** A path, relative to the manifest's folder, the fetch command may read. */
  readonly path?: string;
}

/**
 * How a consumer says which snapshot of a project it accepts. Selection reads the lock and these rules, never the
 * publishing time, so two runs over the same lock choose the same snapshot.
 */
export interface FederationVersionRequirement {
  /** An inclusive range of snapshot versions, such as `>=1.2.0 <2.0.0`. */
  readonly range?: string;
  /**
   * `pinned` accepts only the snapshot the lock pins. `compatible` accepts a pinned snapshot whose version satisfies
   * the range, so an unrelated later snapshot is never chosen in place of the one the lock recorded.
   */
  readonly channel?: "pinned" | "compatible";
}

/** One project of the federation manifest. */
export interface FederationProject {
  /** Stable project id, unique in the manifest: `product`, `docs`, or `consumer`. */
  readonly id: string;
  /** The prefix a fully qualified identity uses, unique in the manifest. */
  readonly namespace: string;
  /** The role this project's snapshot plays. */
  readonly role: FederationRole;
  /** Where the project publishes its bundle. */
  readonly source: FederationSource;
  /** What this consumer accepts from another project, when the manifest declares the dependency. */
  readonly version?: FederationVersionRequirement;
  /** True when the project may be absent without failing the federation; a missing optional bundle is `partial`. */
  readonly optional?: boolean;
}

/** The versioned manifest: the projects, their namespaces, their roles, and their locked sources. */
export interface FederationManifest {
  readonly version: FederationVersion;
  /** Every project, in manifest order. */
  readonly projects: readonly FederationProject[];
}

/** One project's snapshot identity: what a bundle was made from, and what a reference targets. */
export interface FederationSnapshot {
  /** Stable snapshot id, such as `snap-2026-11`. */
  readonly id: string;
  /** The project's product version, used for compatibility selection. */
  readonly version: string;
  /** The commit the snapshot was built from, when one is known. */
  readonly commit?: string;
}

/** The access policy a bundle publishes: whether it is public, and which audiences may read it. */
export interface FederationPolicy {
  /** True when every reader may use this bundle. */
  readonly public: boolean;
  /** The audiences an authorized reader must hold; a private bundle with no audiences is unreadable. */
  readonly audiences: readonly string[];
}

/** One digest-carrying link in a bundle's evidence: the same shape a chain step preserves unchanged. */
export interface FederationEvidenceLink {
  /** The node the evidence is about, by its local id. */
  readonly from: string;
  /** The node the link resolves to: a local id here, or a local id in `target`'s project. */
  readonly to: string;
  /** What the link is, such as `backs`, `checks`, or `asserts`. */
  readonly kind: string;
  /** The other project the target lives in, when the link crosses a project boundary. */
  readonly target?: {
    readonly project: string;
    readonly version?: string;
  };
  /** SHA-256 of the node the link names; a chain step never rewrites it. */
  readonly digest: string;
}

/** The evidence a bundle publishes, already limited to public or explicitly authorized claims. */
export interface FederationEvidenceBundle {
  readonly version: FederationVersion;
  /** Public claims, each naming the node that makes it and the evidence ids that back it. */
  readonly claims: readonly {
    readonly id: string;
    readonly subject: string;
    readonly evidence: readonly string[];
  }[];
  /** The digest-carrying links between a claim, its tests, and its data. */
  readonly links: readonly FederationEvidenceLink[];
}

/**
 * One explicit cross-project reference, the only source of a cross-project edge. Either end is a local node id; the
 * far end names a project and the local id, optionally pinned to one snapshot version.
 */
export interface FederationReference {
  /** The local node id in this bundle that names the far node. */
  readonly from: string;
  /** The far end: a project id, the local node id there, and an optional pinned version. */
  readonly to: {
    readonly project: string;
    readonly id: string;
    readonly version?: string;
  };
  /** The edge kind, such as `links`, `documents`, or `references`. */
  readonly kind: string;
  /** SHA-256 of the reference as written, so a composed edge can prove it is unmodified. */
  readonly digest?: string;
}

/** One bundle a repository publishes: its graph, surface, behaviors, evidence, and the identity they were read at. */
export interface KnowledgeBundle {
  readonly version: FederationVersion;
  /** The engine version that wrote the bundle. */
  readonly tool: string;
  /** The project the bundle belongs to. */
  readonly project: string;
  /** The namespace every identity in this bundle is qualified with. */
  readonly namespace: string;
  /** The role this project's snapshot plays. */
  readonly role: FederationRole;
  /** The snapshot identity. */
  readonly snapshot: FederationSnapshot;
  /** Who may read the bundle. */
  readonly policy: FederationPolicy;
  /** The project's knowledge graph, at its own local identities. */
  readonly graph: Graph;
  /** The project's public surface items. */
  readonly surface: readonly SurfaceItem[];
  /** The project's public behavior contracts. */
  readonly behaviors: readonly BehaviorRecord[];
  /** The evidence the bundle publishes. */
  readonly evidence: FederationEvidenceBundle;
  /** The explicit cross-project references this project makes. */
  readonly references: readonly FederationReference[];
  /** Nodes the project removed, so a reference to one is reported `removed` rather than resolved elsewhere. */
  readonly removed: readonly {
    readonly id: string;
    readonly version: string;
  }[];
  /** SHA-256 of the bundle without this field; a reader verifies it before using any part. */
  readonly digest: string;
}

/** One bundle the lock pins. */
export interface FederationLockEntry {
  /** The project id. */
  readonly project: string;
  readonly namespace: string;
  readonly role: FederationRole;
  /** SHA-256 of the stored bundle bytes, which is also the bundle's own digest; absent when the project has none. */
  readonly sha256?: string;
  /** The snapshot the pinned bundle was built from; absent when the project has none. */
  readonly snapshot?: FederationSnapshot;
  /** The source the bundle was fetched from, as the manifest wrote it. */
  readonly source: string;
  /** True when the project may be absent without failing the federation. */
  readonly optional: boolean;
  /** Why no bundle is pinned, for an optional project that could not be fetched; absent otherwise. */
  readonly missing?: string;
}

/** `federation.lock.json`: the manifest's own hash and every bundle pinned by SHA-256. A build reads only this. */
export interface FederationLock {
  readonly version: FederationVersion;
  /** The manifest file's address as the config writes it, and SHA-256 of its bytes. */
  readonly manifest: {
    readonly source: string;
    readonly sha256: string;
  };
  /** Every pinned bundle by project id. */
  readonly bundles: Readonly<Record<string, FederationLockEntry>>;
}

/** A project the lock names, whether or not its bytes were present. */
export interface FederationMissingBundle {
  readonly project: string;
  readonly optional: boolean;
  /** Why the bundle is absent, in one sentence that names no private content. */
  readonly reason: string;
}

/** What a build reads: the pinned bundles it could verify, and the projects it could not. */
export interface LoadedFederation {
  /** The lock; absent when the site declares no federation. */
  readonly lock?: FederationLock;
  /** Every bundle that verified, by project id. */
  readonly bundles: ReadonlyMap<string, KnowledgeBundle>;
  /** Every locked project whose bytes were absent or failed verification, in project order. */
  readonly missing: readonly FederationMissingBundle[];
  /** True when an optional project is missing, or a required one is; a required one also raises an error. */
  readonly partial: boolean;
  /** SHA-256 over the lock and every loaded digest, for the build cache key. */
  readonly fingerprint?: string;
}

/** What kind of identity a federated node is. It is every graph node kind, plus the bundle's own records. */
export type FederatedNodeKind =
  | GraphNodeKind
  | "surface"
  | "behavior"
  | "test"
  | "evidence"
  | "project"
  | "snapshot"
  | "other";

/** One fully qualified identity: the project, the snapshot, and the node's own id. */
export interface FederatedCitation {
  /** The fully qualified id: `<project>/<snapshot>/<local id>`. */
  readonly id: string;
  /** The project id. */
  readonly project: string;
  /** The namespace the project publishes. */
  readonly namespace: string;
  /** The snapshot id. */
  readonly snapshot: string;
  /** The node's id inside its project. */
  readonly local: string;
  readonly kind: FederatedNodeKind;
  /** A readable label. */
  readonly label: string;
  /** The page or evidence address the node points readers at. */
  readonly url?: string;
  /** The source position in the project's own tree. */
  readonly pos?: SourcePos;
  /** The knowledge status the node carries, when it declares one. */
  readonly knowledge?: GraphKnowledge;
  /** The digest that proves the node is the bundle's own bytes. */
  readonly digest?: string;
}

/** One composed node: its citation, and the project-scoped data the bundle published. */
export interface FederatedNode {
  readonly citation: FederatedCitation;
  /** Audiences allowed to see the node; absent means public. */
  readonly audience?: readonly string[];
  /** The scopes a caller may ask about, when the node's knowledge is limited. */
  readonly knowledge?: GraphKnowledge;
}

/** One composed edge. A cross-project edge exists only where a bundle declared an explicit reference. */
export interface FederatedEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: string;
  /** True when the two ends are in different projects. */
  readonly crossProject: boolean;
  /** The digest the reference carried, preserved unchanged through composition. */
  readonly digest?: string;
  readonly pos?: SourcePos;
}

/** One project's contribution to a composed graph, so a refresh can reuse or replace it whole. */
export interface FederatedUnit {
  readonly project: string;
  readonly snapshot: string;
  readonly digest: string;
  readonly nodes: readonly FederatedNode[];
  readonly edges: readonly FederatedEdge[];
}

/** The composed graph over every visible project. Its digest is independent of the order the bundles were read in. */
export interface FederatedGraph {
  readonly version: FederationVersion;
  /** The visible projects' identities, sorted by project. */
  readonly projects: readonly {
    readonly id: string;
    readonly namespace: string;
    readonly role: FederationRole;
    readonly snapshot: FederationSnapshot;
    readonly digest: string;
  }[];
  /** Every visible node, sorted by qualified id. */
  readonly nodes: readonly FederatedNode[];
  /** Every edge whose both ends are visible, sorted by source, target, and kind. */
  readonly edges: readonly FederatedEdge[];
  /** The composed identity: a hash over the projects, nodes, and edges, in that order. */
  readonly digest: string;
  /** Nodes a visible project recorded removing, by fully qualified id, so a reference to one is `removed`. */
  readonly removed: readonly {
    readonly id: string;
    readonly project: string;
    readonly snapshot: string;
    readonly version: string;
  }[];
  /** True when an optional project was missing. */
  readonly partial: boolean;
  /** The missing projects, by id, so a caller knows what a complete answer would need. */
  readonly missing: readonly FederationMissingBundle[];
}

/** One step of a path between two citations, with the edge that reached it. */
export interface FederatedStep {
  readonly citation: FederatedCitation;
  readonly edge?: FederatedEdge;
}

/** What a cross-repository query takes. */
export interface FederatedQuery {
  /** The fully qualified node, or a project-local id the `project` option qualifies. */
  readonly from?: string;
  /** The project that qualifies a local `from` or `to`. */
  readonly project?: string;
  /** The citation to reach, for the shortest path. */
  readonly to?: string;
  /** Edge kinds to follow; every kind when absent. */
  readonly kinds?: readonly string[];
  /** The longest path from `from`. Default 3, capped at 32. */
  readonly depth?: number;
  /** The most nodes an answer may hold. Default 100, capped at 1000. */
  readonly nodes?: number;
  /** Audiences the caller may read; without it only public projects are visible. */
  readonly allow?: readonly string[];
  /** The scope the caller asks about, so a node whose knowledge does not cover it is not definitive. */
  readonly scope?: readonly KnowledgeScope[];
}

/** What a cross-repository query returns. */
export interface FederatedQueryResult {
  /** The composed graph the answer was read from. */
  readonly snapshot: string;
  /** The starting citation, when one was named. */
  readonly from?: FederatedCitation;
  /** `present` when visible, `removed` when the bundle recorded its removal, else `unknown`. */
  readonly status: "present" | "removed" | "unknown";
  readonly neighbors: readonly {
    readonly citation: FederatedCitation;
    readonly edge: FederatedEdge;
    readonly direction: "out" | "in";
  }[];
  /** The shortest path from `from` to `to`, when asked and found. */
  readonly path?: readonly FederatedStep[];
  readonly found?: boolean;
  /** True when a bound stopped the answer, or an optional project was missing. */
  readonly partial: boolean;
  /** True when every returned node's knowledge covers the query's scope. */
  readonly definitive: boolean;
  /** Every returned node's fully qualified citation, deduplicated and sorted. */
  readonly citations: readonly FederatedCitation[];
  /** The projects whose bundles were missing, so a caller sees what the answer could not include. */
  readonly missing: readonly FederationMissingBundle[];
}

/** How a stable reference names its target. */
export type FederatedReferenceStatus = "resolved" | "removed" | "incompatible" | "unknown" | "withheld";

/** A stable reference another feature, such as Decision Memory, stores and resolves later. */
export interface FederatedReference {
  /** Always `federation`, so a reference is read without guessing its namespace. */
  readonly kind: "federation";
  /** The project id. */
  readonly project: string;
  /** The local node id. */
  readonly id: string;
  /** The snapshot version the reference was resolved at, when one was named. */
  readonly version?: string;
  /** `pinned` names one snapshot; `compatible` accepts a compatible channel. Default `pinned`. */
  readonly channel?: "pinned" | "compatible";
}

/** What resolving a stable reference found. */
export interface FederatedReferenceResolution {
  readonly reference: FederatedReference;
  /** `resolved` when the target exists and its version satisfies the reference; `removed` when the project recorded
   * removing it; `incompatible` when only another version exists; `withheld` when the project is not readable;
   * `unknown` otherwise. */
  readonly status: FederatedReferenceStatus;
  /** The citation that resolved, when the status is `resolved`. */
  readonly citation?: FederatedCitation;
  /** The snapshot version the target was recorded at, when the project recorded a removal or a mismatch. */
  readonly at?: string;
  /** Why the status is what it is, in one sentence that names no withheld content. */
  readonly detail: string;
}

/** One selected cross-repository fragment. */
export interface FederatedPackItem {
  /** The project the fragment came from. */
  readonly project: string;
  readonly citation: FederatedCitation;
  /** The exact text the bundle published for this fragment. */
  readonly content: string;
  /** The estimator's count for {@link content}. */
  readonly tokens: number;
  /** Why the fragment is in the pack, such as `behavior.surface` or `evidence.claims`. */
  readonly reason: string;
}

/** One input the shared budget or an access rule kept out of the pack. */
export interface FederatedPackOmission {
  /** The project the omission belongs to; absent when naming it would disclose a withheld project. */
  readonly project?: string;
  readonly ref: string;
  readonly reason: "budget" | "permission" | "missing";
  /** One sentence naming what happened and what would change it, never a withheld value. */
  readonly detail: string;
}

/** What a cross-repository context pack takes. */
export interface FederatedPackRequest {
  /** The topic the pack is about, used for ranking and the title. */
  readonly goal: string;
  /** The starting citations; a fully qualified id or one qualified by `project`. */
  readonly from: readonly string[];
  /** The project that qualifies a local `from` entry. */
  readonly project?: string;
  /** One shared budget for every project, in tokens. */
  readonly budget: number;
  /** Audiences the caller may read. */
  readonly allow?: readonly string[];
  /** The most fragments one project may contribute, so no project takes another's whole share. */
  readonly perProject?: number;
}

/** What a cross-repository context pack returns. */
export interface FederatedPack {
  readonly version: FederationVersion;
  readonly goal: string;
  readonly budget: number;
  /** The Markdown pack. */
  readonly markdown: string;
  /** The selected fragments, attributed to their project. */
  readonly items: readonly FederatedPackItem[];
  /** The exact token accounting of the Markdown. */
  readonly accounting: {
    readonly requested: number;
    readonly fragments: number;
    readonly template: number;
    readonly safety: number;
    readonly used: number;
    readonly remaining: number;
    readonly upper: number;
    readonly margin: number;
  };
  /** What was left out, with the project when naming it discloses nothing. */
  readonly omissions: readonly FederatedPackOmission[];
  /** The missing projects, so a pack never passes for complete. */
  readonly missing: readonly FederationMissingBundle[];
  /** True when the pack is partial, for a missing bundle or an omission. */
  readonly partial: boolean;
}

/** One unmodified link of an evidence chain. */
export interface EvidenceChainLink {
  readonly from: FederatedCitation;
  readonly to: FederatedCitation;
  readonly kind: string;
  /** The digest the bundle carried; the chain never rewrites it. */
  readonly digest: string;
  /** True when the recomputed digest still matches. */
  readonly verified: boolean;
}

/** One cross-project evidence chain: a claim, followed to another project's test or data. */
export interface EvidenceChain {
  readonly version: FederationVersion;
  /** The claim the chain starts from, by fully qualified id. */
  readonly claim: FederatedCitation;
  /** Every link followed, in traversal order. */
  readonly links: readonly EvidenceChainLink[];
  /** The nodes reached, deduplicated and sorted. */
  readonly reached: readonly FederatedCitation[];
  /** True when every link verified and no required bundle was missing. */
  readonly complete: boolean;
  /** The missing projects, so an incomplete chain says what it needs. */
  readonly missing: readonly FederationMissingBundle[];
}

/** What a project refresh returns: the recomposed graph, and which projects were reused whole. */
export interface FederationRefresh {
  readonly reused: readonly string[];
  readonly recomposed: readonly string[];
  /** The recomposed graph, which must deep-equal a full composition over the same input. */
  readonly graph: FederatedGraph;
}
