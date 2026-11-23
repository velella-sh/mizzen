/**
 * The public product surface: every symbol, command, configuration key, OpenAPI operation, and data field a product
 * publishes, with the source position that declares it and the documentation evidence that covers it. An adapter reads
 * one area of the surface and returns a versioned result; an adapter whose result is not the shape below is rejected
 * whole, never partially, so coverage never counts an item an adapter did not actually read.
 *
 * A report keeps three documentation states apart — `complete`, `partial`, and `missing` — and a documented exclusion
 * apart from a gap, so a deliberately undocumented item is never counted as missing.
 */
import type { SourcePos } from "./source.ts";

/** The surface format this engine writes and reads. */
export type SurfaceVersion = 1;

/** The area of the product a surface item belongs to. The order is the order a report lists them. */
export type SurfaceArea = "api" | "cli" | "config" | "openapi" | "data" | "version";

/** What one item of the public surface is. */
export type SurfaceItemKind =
  | "symbol"
  | "command"
  | "argument"
  | "flag"
  | "config-key"
  | "operation"
  | "parameter"
  | "response"
  | "collection"
  | "field"
  | "version";

/** How stable an item is. `removed` is kept so a comparison can name what a release dropped. */
export type SurfaceStability = "stable" | "experimental" | "deprecated" | "removed";

/** The product versions an item passed through. Only `introduced` is required when a version is known at all. */
export interface SurfaceVersionInfo {
  /** The product version that introduced the item, or `unknown` when no source states it. */
  readonly introduced: string;
  /** The product version that deprecated it, when one did. */
  readonly deprecated?: string;
  /** The product version that removed it, when one did. */
  readonly removed?: string;
  /** The item that replaces it, when it is deprecated. */
  readonly successor?: string;
}

/**
 * One item of the public surface. `id` is stable across releases and across a source move, so a comparison keys on it
 * and a file rename alone never changes coverage. `source` is the exact place the item is declared.
 */
export interface SurfaceItem {
  /** Stable identity: `<kind>:<name>`, unique within a report, such as `command:build` or `config:title`. */
  readonly id: string;
  readonly area: SurfaceArea;
  readonly kind: SurfaceItemKind;
  /** The item's readable name, such as `build`, `title`, or `getPackages`. */
  readonly name: string;
  /** The exact span that declares the item. */
  readonly source: SourcePos;
  readonly stability: SurfaceStability;
  /** The published signature or one-line shape, when the source states one. */
  readonly signature?: string;
  /** The parent item's id: a flag's command, an operation's parameter, a collection's field. */
  readonly parent?: string;
  /** The version metadata, when any source states it. */
  readonly version?: SurfaceVersionInfo;
}

/** A semantic finding an adapter makes about its own area, such as help text that drifts from the parser. */
export interface SurfaceFinding {
  /** A stable code, such as `cli.help-drift`. */
  readonly code: string;
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
  readonly pos?: SourcePos;
}

/** One adapter's validated result: every item of one area, plus the findings it made while reading. */
export interface SurfaceAdapterResult {
  readonly version: SurfaceVersion;
  readonly area: SurfaceArea;
  /** Sorted by id, so two reads of the same input are byte-identical. */
  readonly items: readonly SurfaceItem[];
  readonly findings: readonly SurfaceFinding[];
}

/** Why an adapter's output is not the shape this contract reads. A structural problem rejects the whole result. */
export interface SurfaceAdapterProblem {
  /** A stable code, such as `surface.invalid-item`. */
  readonly code: string;
  readonly message: string;
  readonly pos?: SourcePos;
}

/** The kind of documentation evidence an item has. */
export type SurfaceEvidenceKind = "link" | "code-reference" | "directive";

/** One place a documentation page points at a surface item. */
export interface SurfaceEvidence {
  readonly kind: SurfaceEvidenceKind;
  /** The documentation file that holds the reference. */
  readonly file: string;
  readonly line: number;
  readonly column: number;
  /** The reference as the page wrote it, trimmed. */
  readonly text: string;
}

/** How well one item is documented. */
export type SurfaceDocState = "complete" | "partial" | "missing";

/** One item's documentation state, with the evidence that decided it. */
export interface SurfaceMatch {
  /** The item id. */
  readonly item: string;
  readonly area: SurfaceArea;
  readonly state: SurfaceDocState;
  /** Every reference found, sorted by file, line, column, then kind. */
  readonly evidence: readonly SurfaceEvidence[];
}

/** Why one item is a gap: it has no reference, or only a weak one. */
export type SurfaceGapKind = "undocumented" | "partial";

/** One documentation gap. The kind, id, source, and introduction version make it actionable without the report. */
export interface SurfaceGap {
  readonly item: string;
  readonly area: SurfaceArea;
  readonly kind: SurfaceItemKind;
  /** Where the item is declared. */
  readonly source: SourcePos;
  /** The product version that introduced the item, or `unknown`. */
  readonly introduced: string;
  readonly gap: SurfaceGapKind;
}

/** An item whose documentation is deliberately elsewhere, or deliberately absent, with the author's reason. */
export interface SurfaceExclusion {
  readonly id: string;
  readonly reason: string;
}

/** The counts of one scope: a report, or one area of it. */
export interface SurfaceCounts {
  /** Items with complete documentation. */
  readonly documented: number;
  /** Items with only weak evidence. */
  readonly partial: number;
  /** Items with no evidence. */
  readonly undocumented: number;
  /** Items the configuration excludes, counted apart from every documentation state. */
  readonly excluded: number;
  /** Items in scope, which is `documented + partial + undocumented`; an exclusion is never in scope. */
  readonly total: number;
}

/** The coverage of one area. */
export interface SurfaceAreaCoverage {
  readonly area: SurfaceArea;
  readonly counts: SurfaceCounts;
  /** `documented / total` as a percentage rounded to two decimals, or `null` when nothing is in scope. */
  readonly documentedPercent: number | null;
  /** `(partial + undocumented) / total` as a percentage rounded to two decimals, or `null` when nothing is in scope. */
  readonly undocumentedPercent: number | null;
}

/** The whole coverage: the totals and one row per area, in {@link SURFACE_AREAS} order. */
export interface SurfaceCoverage {
  readonly counts: SurfaceCounts;
  readonly documentedPercent: number | null;
  readonly undocumentedPercent: number | null;
  readonly areas: readonly SurfaceAreaCoverage[];
}

/** Where a report came from. */
export interface SurfaceReportSource {
  /** The product version the adapters inventoried, when one was known. */
  readonly version?: string;
}

/** The versioned report `mizzen surface` prints and the page JSON publishes. */
export interface SurfaceReport {
  readonly version: SurfaceVersion;
  readonly source: SurfaceReportSource;
  /** Every item, sorted by area then id. */
  readonly items: readonly SurfaceItem[];
  /** One match per item, in item order. */
  readonly matches: readonly SurfaceMatch[];
  /** Every gap, sorted by area then id, with excluded items left out. */
  readonly gaps: readonly SurfaceGap[];
  /** The documented exclusions, sorted by id. */
  readonly exclusions: readonly SurfaceExclusion[];
  readonly coverage: SurfaceCoverage;
  /** Findings the adapters made, sorted by code then message. */
  readonly findings: readonly SurfaceFinding[];
}

/** What happened to one item between two reports. */
export type SurfaceChangeKind = "added" | "removed" | "documented" | "undocumented";

/** One item that changed between two reports. A source move alone is not a change. */
export interface SurfaceChange {
  readonly id: string;
  readonly area: SurfaceArea;
  readonly change: SurfaceChangeKind;
  /** The earlier documentation state, absent for `added`. */
  readonly from?: SurfaceDocState;
  /** The later documentation state, absent for `removed`. */
  readonly to?: SurfaceDocState;
}

/** The comparison of a report with an earlier one. */
export interface SurfaceComparison {
  readonly version: SurfaceVersion;
  /** The earlier report's product version, when it had one. */
  readonly baseline?: string;
  /** The later report's product version, when it has one. */
  readonly current?: string;
  /** Every change, sorted by area then id. */
  readonly changes: readonly SurfaceChange[];
  /** The count difference per field, `current` minus `baseline`. */
  readonly delta: SurfaceCounts;
}
