/**
 * The knowledge graph contract: a versioned snapshot of nodes and edges over the site model, every node and edge
 * carrying the source position it was read from. A snapshot is immutable and identified by `snapshot.id`, so two
 * builds are never merged by accident. An edge whose source or target is not a node of the same snapshot is invalid
 * and is rejected by the builder, never written to a graph.
 */
import type { SourcePos } from "./source.ts";

/** The contract version this engine writes and reads. */
export type GraphFormat = 1;

/** What a node stands for. */
export type GraphNodeKind =
  | "page"
  | "block"
  | "heading"
  | "link"
  | "include"
  | "api"
  | "symbol"
  | "snippet"
  | "collection"
  | "record"
  | "field"
  | "transform"
  | "join"
  | "derived"
  | "claim"
  | "evidence"
  | "check"
  | "lineage";

/** How one node relates to another. */
export type GraphEdgeKind =
  | "contains"
  | "links"
  | "targets"
  | "includes"
  | "documents"
  | "references"
  | "renders"
  | "asserts"
  | "backs"
  | "checks"
  | "derives"
  | "reads"
  | "writes"
  | "joins";

/** A scalar or list a node publishes as structured metadata. */
export type GraphValue = string | number | boolean | readonly string[];

/**
 * The knowledge a node carries: its status, the scope that limits it, the public citations a reader may follow, and
 * whether it needs review. A private rationale or citation value is never carried here.
 */
export interface GraphKnowledge {
  readonly status: import("./knowledge.ts").KnowledgeStatus;
  readonly scope: readonly GraphKnowledgeScope[];
  /** Public citations only; a private citation is left out rather than redacted in place. */
  readonly citations?: readonly string[];
  /** True when the declaration needs review. */
  readonly review?: boolean;
  readonly expires?: string;
}

/** One node of a snapshot, with the source position and audience that make it inspectable. */
export interface GraphNode {
  /** Stable identity within the site: a page is named by its source path, a block by its block id. */
  readonly id: string;
  readonly kind: GraphNodeKind;
  /** Readable title, if the node has one. */
  readonly label: string;
  /** Where the node was read from. */
  readonly pos?: SourcePos;
  /** The page URL or evidence address the node points readers at. */
  readonly url?: string;
  /** The node's structured metadata, already public: no secret values or machine-local paths. */
  readonly data?: Readonly<Record<string, GraphValue>>;
  /** The node's explicit knowledge status, when it declares one; absent means no limitation is declared. */
  readonly knowledge?: GraphKnowledge;
  /** Audiences allowed to see the node. Absent means public. */
  readonly audience?: readonly string[];
  /** The builder unit that owns the node, so a refresh reuses every unchanged unit. */
  readonly unit?: string;
}

/** One directed edge of a snapshot. */
export interface GraphEdge {
  /** Source node id. */
  readonly from: string;
  /** Target node id. */
  readonly to: string;
  readonly kind: GraphEdgeKind;
  /** Where the relationship is written in the source. */
  readonly pos?: SourcePos;
  /** The builder unit that owns the edge, so a refresh reuses every unchanged unit. */
  readonly unit?: string;
}

/** One immutable graph snapshot. */
export interface GraphSnapshot {
  readonly format: GraphFormat;
  /** Stable snapshot identity: the caller's label, or a hash of the snapshot's own contents. */
  readonly id: string;
  /** A caller-supplied human label, when the id is a hash. */
  readonly label?: string;
}

/** One snapshot: its identity, nodes, and edges, each list in stable order. */
export interface Graph {
  readonly format: GraphFormat;
  readonly snapshot: GraphSnapshot;
  /** Sorted by id (code points). */
  readonly nodes: readonly GraphNode[];
  /** Sorted by source, target, kind, and position. */
  readonly edges: readonly GraphEdge[];
}

/** Independent snapshots kept beside each other; a query reads exactly one. */
export interface GraphArchive {
  readonly format: GraphFormat;
  /** Sorted by snapshot id. */
  readonly snapshots: readonly Graph[];
}

/** One rejected edge or other graph problem. */
export interface GraphProblem {
  /** A stable code, such as `graph.edge-invalid`. */
  readonly code: string;
  /** `error` rejects a write; `warning` reports a reference the graph could not resolve. */
  readonly severity: "error" | "warning";
  readonly message: string;
  readonly pos?: SourcePos;
  /** The rejected edge, so a caller can name it without reading the graph. */
  readonly edge?: GraphEdge;
}

/** What a build or refresh returns: the complete graph and every finding. */
export interface GraphBuildResult {
  readonly graph: Graph;
  readonly diagnostics: readonly GraphProblem[];
}

/** One link written in a page, as a collector read it. */
export interface GraphLinkInput {
  /** The source path of the page that holds the link. */
  readonly page: string;
  readonly href: string;
  readonly pos: SourcePos;
  readonly text?: string;
  /** The block id the link sits in, when a collector resolved it. */
  readonly block?: string;
  /** The page source path the link targets, when the collector resolved it. */
  readonly target?: string;
  /** False when the target is outside the site. */
  readonly internal?: boolean;
}

/** One `::include` directive, as the include expander read it. */
export interface GraphIncludeInput {
  /** The source path of the file that holds the directive. */
  readonly from: string;
  /** The source path the directive names. */
  readonly path: string;
  readonly pos: SourcePos;
  readonly missing?: boolean;
}

/** One code reference a page writes, such as `src/foo.ts:12`. */
export interface GraphCodeRefInput {
  /** The source path of the page that holds the reference. */
  readonly page: string;
  readonly path: string;
  readonly line: number;
  readonly endLine?: number;
  /** The symbol the paragraph's inline code names, when it names one. */
  readonly symbol?: string;
  /** The block id the reference sits in, when a collector resolved it. */
  readonly block?: string;
  readonly pos: SourcePos;
  readonly text?: string;
}

/** One symbol a referenced source file exports. */
export interface GraphSymbolInput {
  /** The source path of the file that declares the symbol. */
  readonly file: string;
  readonly name: string;
  readonly kind: string;
  readonly line: number;
}

/** One external claim, check result, or lineage answer attached to a record field. */
export interface GraphClaimInput {
  readonly collection: string;
  readonly record: string;
  readonly field: string;
  /** `evidence` for a source claim, `check` for a check result, `lineage` for a derived value. */
  readonly kind: "evidence" | "check" | "lineage";
  /** The evidence, check, or lineage id. */
  readonly id: string;
  readonly title: string;
  /** The evidence address, for a source claim. */
  readonly url?: string;
  /** The check's status, for a check result. */
  readonly status?: "pass" | "fail" | "unknown";
  readonly pos?: SourcePos;
}

/** One scope limit a graph node carries, in the same `kind:value` shape a declaration writes. */
export interface GraphKnowledgeScope {
  readonly kind: import("./knowledge.ts").KnowledgeScopeKind;
  readonly value: string;
}

/**
 * The public knowledge of one node: its status, the scope that limits it, and the citations a reader may follow.
 * A private rationale or citation value is never carried here; it is left out or replaced with a placeholder, so a
 * graph never leaks a private value.
 */
export interface GraphKnowledgeInput {
  /** The node whose knowledge this is, such as a page id or a claim id. */
  readonly node: string;
  readonly status: import("./knowledge.ts").KnowledgeStatus;
  readonly scope: readonly GraphKnowledgeScope[];
  /** Public citations only; a private citation is left out rather than redacted in place. */
  readonly citations?: readonly string[];
  /** True when the declaration needs review, so a query marks it as not definitive. */
  readonly review?: boolean;
  readonly expires?: string;
  readonly pos?: SourcePos;
}

/** Everything {@link buildGraph} reads. Nothing here is reread from disk. */
export interface GraphInput {
  /** The site model, for pages, blocks, headings, collections, records, and config. */
  readonly site: import("./content.ts").Site;
  /** Links the collector parsed from the pages. */
  readonly links?: readonly GraphLinkInput[];
  /** Include directives the collector expanded. */
  readonly includes?: readonly GraphIncludeInput[];
  /** Code references the collector parsed from the pages. */
  readonly codeRefs?: readonly GraphCodeRefInput[];
  /** Exported symbols of the files the code references name. */
  readonly symbols?: readonly GraphSymbolInput[];
  /** Claims, checks, and lineage the collector read beyond the site model. */
  readonly evidence?: readonly GraphClaimInput[];
  /** Knowledge declarations the collector read, by node id, so a query can publish a status a node carries. */
  readonly knowledge?: readonly GraphKnowledgeInput[];
  /** A caller-supplied snapshot label; without it the snapshot id is a hash of the graph's own contents. */
  readonly snapshot?: string;
  /** Extra audiences by node id or unit, merged over the ones read from front matter and record fields. */
  readonly audience?: Readonly<Record<string, readonly string[]>>;
}
