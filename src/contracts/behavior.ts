/**
 * Product behavior contracts: a documented behavior is a stable id, a title, a normative description, and the exact
 * source span it is written at, linked to the public surface it describes, the tests that prove it, and the evidence
 * that supports it. A behavior is versioned, has a support status and an optional replacement, and may vary by
 * operating system, language, or runtime.
 *
 * Two statuses are kept apart on purpose. {@link BehaviorSupportStatus} is what the product promises; it is authored.
 * {@link BehaviorVerification} is what the evidence policy can prove; it is computed. A supported behavior without the
 * evidence its status requires is `unverified`, never `verified`.
 */
import type { SourcePos } from "./source.ts";
import type { SurfaceArea, SurfaceItemKind, SurfaceStability } from "./surface.ts";

/** The behavior report format this engine writes and reads. */
export type BehaviorVersion = 1;

/** What the product promises about a behavior. */
export type BehaviorSupportStatus = "supported" | "experimental" | "deprecated" | "removed";

/** Every support status, in report order. */
export type BehaviorStatusCounts = {
  readonly supported: number;
  readonly experimental: number;
  readonly deprecated: number;
  readonly removed: number;
};

/** The outcome a linked test is expected to have. */
export type BehaviorTestOutcome = "passed" | "failed" | "skipped";

/** What an evidence reference points at. Only the first three kinds can verify a `supported` behavior. */
export type BehaviorEvidenceKind = "test" | "ci" | "benchmark" | "document";

/** Whether the evidence policy could prove the behavior. */
export type BehaviorVerification = "verified" | "unverified";

/** Why a behavior is unverified, in the fixed order the report writes. */
export type BehaviorUnverifiedReason =
  | "missing-surface"
  | "missing-test"
  | "nonpassing-test"
  | "missing-evidence"
  | "unresolved-evidence"
  | "invalid-replacement";

/** The product versions a behavior passed through: introduced, changed, deprecated, and removed. */
export interface BehaviorVersionHistory {
  /** The product version that introduced the behavior. Required. */
  readonly introduced: string;
  /** Product versions in which the behavior changed, in the declared order. */
  readonly changed?: readonly string[];
  /** The product version that deprecated the behavior. */
  readonly deprecated?: string;
  /** The product version that removed the behavior. */
  readonly removed?: string;
}

/**
 * One environment a behavior is scoped to. At least one dimension is present. A behavior with no environments
 * applies everywhere; with environments, each result is scoped to the environments it covers.
 */
export interface BehaviorEnvironment {
  /** Operating system, such as `linux` or `windows`. */
  readonly os?: string;
  /** Language, such as `en` or `fa`. */
  readonly language?: string;
  /** Runtime, such as `node>=24`. */
  readonly runtime?: string;
}

/** One test that proves a behavior, with the outcome the test is expected to have. */
export interface BehaviorTestDeclaration {
  /** Test file, relative to the repository root. */
  readonly file: string;
  /** The test's name, when the file holds more than one; it must appear in the file. */
  readonly name?: string;
  /** The outcome the test is expected to have. */
  readonly outcome: BehaviorTestOutcome;
  /** `false` keeps the test's name out of public output; the file and outcome still appear. Default `true`. */
  readonly public?: boolean;
}

/** One evidence reference. An `https:` URL or a root-relative path is a public link; an id names a pinned envelope. */
export interface BehaviorEvidenceDeclaration {
  /** A pinned evidence id from `.mizzen/evidence.lock.json`. */
  readonly id?: string;
  /** An `https:` URL or a root-relative path that links the evidence. */
  readonly url?: string;
  /** A readable label for the evidence link. */
  readonly title?: string;
  /** What the evidence is. Default `document` for a URL and `test` for an id. */
  readonly kind?: BehaviorEvidenceKind;
  /** `false` keeps the id, URL, and title out of public output. Default `true`. */
  readonly public?: boolean;
}

/**
 * One authored behavior declaration, as it was read from a page's front matter. `source` is the exact span of the
 * declaration, not the whole file, so a finding points at the behavior that caused it.
 */
export interface BehaviorDeclaration {
  /** Stable identity across releases and source moves, such as `build.deterministic-output`. */
  readonly id: string;
  /** A short human title. */
  readonly title: string;
  /** The normative statement of what the product does. */
  readonly normative: string;
  /** The exact span that declares the behavior. */
  readonly source: SourcePos;
  /** What the product promises. */
  readonly status: BehaviorSupportStatus;
  /** The versions the behavior passed through. */
  readonly versions: BehaviorVersionHistory;
  /** The behavior that replaces this one, when it is deprecated or removed. */
  readonly replacement?: string;
  /** The environments this behavior is scoped to; empty means it applies everywhere. */
  readonly environments: readonly BehaviorEnvironment[];
  /** Public-surface item ids the behavior describes, such as `command:build` or `symbol:buildSite`. */
  readonly surface: readonly string[];
  /** The tests that prove it, with their expected outcomes. */
  readonly tests: readonly BehaviorTestDeclaration[];
  /** The evidence that supports it. */
  readonly evidence: readonly BehaviorEvidenceDeclaration[];
  /** `false` keeps the whole behavior out of public output. Default `true`. */
  readonly public?: boolean;
}

/** What the evidence policy requires of a behavior with one support status. */
export interface BehaviorEvidenceRequirement {
  /** How many linked tests must be found and expected to pass. */
  readonly tests: number;
  /** How many evidence references must resolve to a kind in {@link BehaviorEvidenceRequirement.kinds}. */
  readonly evidence: number;
  /** The evidence kinds that satisfy this status. Empty when no evidence is required. */
  readonly kinds: readonly BehaviorEvidenceKind[];
}

/** The evidence policy: what each support status must prove before it is verified. */
export type BehaviorEvidencePolicy = Readonly<Record<BehaviorSupportStatus, BehaviorEvidenceRequirement>>;

/** One linked surface item, resolved against the public surface inventory. */
export interface BehaviorSurfaceLink {
  /** The surface item id the behavior names. */
  readonly item: string;
  /** `linked` when the item exists; `missing` when the surface no longer publishes it. */
  readonly state: "linked" | "missing";
  /** The item's area, when it exists. */
  readonly area?: SurfaceArea;
  /** The item's kind, when it exists. */
  readonly kind?: SurfaceItemKind;
  /** The item's readable name, when it exists. */
  readonly name?: string;
  /** The item's stability, when it exists. */
  readonly stability?: SurfaceStability;
  /** The item's published signature, when it has one. A change is behavior drift. */
  readonly signature?: string;
  /** The exact place the item is declared. */
  readonly source?: SourcePos;
}

/** One linked test, resolved against the repository and the snapshot it was read from. */
export interface BehaviorTestLink {
  /** Test file, relative to the repository root. */
  readonly file: string;
  /** The test's name, when the declaration gives one and it is public. */
  readonly name?: string;
  /** The outcome the test is expected to have. */
  readonly outcome: BehaviorTestOutcome;
  /** `found` when the file and the optional name exist; `missing` otherwise. */
  readonly state: "found" | "missing";
  /** SHA-256 of the test file's bytes, when it was read. A change is behavior drift. */
  readonly digest?: string;
  /** True when a private test name was withheld from public output. */
  readonly redacted?: boolean;
}

/** One evidence reference, resolved against the evidence lock. */
export interface BehaviorEvidenceLink {
  /** What the evidence is. */
  readonly kind: BehaviorEvidenceKind;
  /** `resolved` when a public URL or a pinned id exists; `unresolved` otherwise. */
  readonly state: "resolved" | "unresolved";
  /** The pinned evidence id, when it is public. */
  readonly id?: string;
  /** The public evidence URL, when one is given. */
  readonly url?: string;
  /** The readable label, when it is public. */
  readonly title?: string;
  /** SHA-256 of the pinned envelope or of the public URL, when resolved. A change is behavior drift. */
  readonly digest?: string;
  /** True when the author kept the id, URL, and title private. */
  readonly redacted?: boolean;
}

/** What the evidence policy made of one behavior. */
export interface BehaviorVerificationState {
  /** `verified` only when no reason applies. */
  readonly status: BehaviorVerification;
  /** Every reason the behavior is unverified, in the fixed order the report writes. */
  readonly reasons: readonly BehaviorUnverifiedReason[];
  /** What the status required. */
  readonly required: BehaviorEvidenceRequirement;
}

/** The page a behavior was documented on, so an evidence link is never guessed from a source path. */
export interface BehaviorPage {
  /** Output URL, including `base`. */
  readonly url: string;
  /** The source file, relative to the repository root. */
  readonly source: string;
}

/** One behavior in the public report: its declaration, the resolved links, and the evidence verdict. */
export interface BehaviorRecord {
  /** Stable identity. */
  readonly id: string;
  /** Short human title. */
  readonly title: string;
  /** The normative statement. */
  readonly normative: string;
  /** The exact span the behavior is declared at. */
  readonly source: SourcePos;
  /** The documentation page that declares it. */
  readonly page: BehaviorPage;
  /** What the product promises now. */
  readonly status: BehaviorSupportStatus;
  /** The status at the queried product version, when the report was filtered by a version. */
  readonly statusAtVersion?: BehaviorSupportStatus;
  /** The versions the behavior passed through. */
  readonly versions: BehaviorVersionHistory;
  /** The behavior that replaces it, when it is deprecated or removed. */
  readonly replacement?: string;
  /** The environments it covers; empty means everywhere. */
  readonly environments: readonly BehaviorEnvironment[];
  /** The resolved surface links. */
  readonly surface: readonly BehaviorSurfaceLink[];
  /** The resolved test links. */
  readonly tests: readonly BehaviorTestLink[];
  /** The resolved evidence links, with private values redacted. */
  readonly evidence: readonly BehaviorEvidenceLink[];
  /** The evidence policy's verdict. */
  readonly verification: BehaviorVerificationState;
}

/** One structural finding the behavior report made, such as a duplicate id or an invalid replacement. */
export interface BehaviorFinding {
  /** A stable code, such as `behavior.duplicate-id`. */
  readonly code: string;
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
  /** Where the finding is. */
  readonly pos?: SourcePos;
  /** Every location involved, such as both declarations of a duplicate id. */
  readonly locations?: readonly SourcePos[];
}

/** The counts of one behavior report. */
export interface BehaviorCoverage {
  /** Public behaviors in the report. */
  readonly total: number;
  /** Public behaviors the policy verified. */
  readonly verified: number;
  /** Public behaviors the policy could not verify. */
  readonly unverified: number;
  /** Behaviors whose author kept them out of public output. */
  readonly private: number;
  /** The public behaviors by support status. */
  readonly byStatus: BehaviorStatusCounts;
  /** The resolved surface links and the missing ones across every public behavior. */
  readonly surface: {
    readonly linked: number;
    readonly missing: number;
  };
}

/** Where a behavior report came from. */
export interface BehaviorReportSource {
  /** The product version the report was queried or inventoried at, when one was named. */
  readonly version?: string;
}

/** The versioned behavior report the CLI prints and the `behavior` output writes. */
export interface BehaviorReport {
  readonly version: BehaviorVersion;
  readonly source: BehaviorReportSource;
  /** The evidence policy the verification used, published so a reader can see why a status requires what it does. */
  readonly policy: BehaviorEvidencePolicy;
  /** Every public behavior, sorted by id. */
  readonly behaviors: readonly BehaviorRecord[];
  readonly coverage: BehaviorCoverage;
  /** Structural findings, sorted by code then location then message. */
  readonly findings: readonly BehaviorFinding[];
}

/** What changed in one behavior between two reports. */
export type BehaviorDriftKind =
  | "signature"
  | "surface-added"
  | "surface-removed"
  | "test"
  | "evidence"
  | "contract";

/** One behavior that needs review, with the documentation and the tests shown together. */
export interface BehaviorDrift {
  /** The behavior id. */
  readonly behavior: string;
  /** Every kind of change that made it drift, in the fixed order above. */
  readonly kinds: readonly BehaviorDriftKind[];
  /** The current documentation statement, so a reviewer sees what is claimed. */
  readonly documentation: {
    readonly title: string;
    readonly normative: string;
    readonly source: SourcePos;
    readonly page: BehaviorPage;
  };
  /** The linked surface items before and after. */
  readonly surface: {
    readonly before: readonly BehaviorSurfaceLink[];
    readonly after: readonly BehaviorSurfaceLink[];
  };
  /** The linked tests before and after, including their file digests. */
  readonly tests: {
    readonly before: readonly BehaviorTestLink[];
    readonly after: readonly BehaviorTestLink[];
  };
  /** The evidence before and after. */
  readonly evidence: {
    readonly before: readonly BehaviorEvidenceLink[];
    readonly after: readonly BehaviorEvidenceLink[];
  };
}

/** The comparison of a behavior report with an earlier one. */
export interface BehaviorComparison {
  readonly version: BehaviorVersion;
  /** The earlier report's product version, when it had one. */
  readonly baseline?: string;
  /** The later report's product version, when it has one. */
  readonly current?: string;
  /** Behaviors the later report added, sorted by id. */
  readonly added: readonly string[];
  /** Behaviors the later report removed, sorted by id. */
  readonly removed: readonly string[];
  /** Every behavior whose signature, test, evidence, or contract changed, sorted by id. */
  readonly drift: readonly BehaviorDrift[];
  /** How many behaviors were byte-identical by id and resolved state. */
  readonly unchanged: number;
}

/** A stable reference to a behavior, for another feature such as Decision Memory to store. */
export interface BehaviorReference {
  /** Always `behavior`, so a reference is read without guessing its namespace. */
  readonly kind: "behavior";
  /** The behavior id. */
  readonly id: string;
  /** The product version the reference was resolved at, when one was named. */
  readonly version?: string;
}

/** How a caller asks for a version of a behavior contract. */
export interface BehaviorQuery {
  /** The product version whose contracts are wanted. */
  readonly version?: string;
  /** Only this support status. */
  readonly status?: BehaviorSupportStatus;
  /** Only behaviors that cover this environment. */
  readonly environment?: BehaviorEnvironment;
}

/** The answer to a behavior query: a stable reference and the contracts at the queried version. */
export interface BehaviorLookupResult {
  readonly version: BehaviorVersion;
  readonly query: BehaviorQuery;
  /** The matching behaviors, sorted by id, each carrying its status at the queried version when one was named. */
  readonly behaviors: readonly BehaviorRecord[];
}
