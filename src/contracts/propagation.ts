/**
 * Downstream change propagation: a consumer declares the public surfaces, behaviors, collections, pages, symbols,
 * decisions, and evidence it depends on, with a version policy and an approval policy. Two locked snapshots of one
 * upstream project are diffed into versioned semantic change events, each carrying the source position it was read from
 * and a hash of the changed record. An event is matched only against a consumer that declared the dependency it names,
 * so an internal change that preserves the public surface emits nothing external.
 *
 * A preview names the downstream snapshots, pages, and proposed tasks before anything is published. A proposal keeps
 * the upstream source untouched and carries only the rationale, decision links, and evidence the consumer is
 * authorized to read. Applying a proposal is a function of the consumer's approval policy, and a receipt makes
 * reprocessing the same snapshots a no-op that still returns the earlier result.
 */
import type { BehaviorRecord } from "./behavior.ts";
import type { DecisionRecord } from "./decisions.ts";
import type { FederationEvidenceBundle } from "./federation.ts";
import type { Graph } from "./graph.ts";
import type { SourcePos } from "./source.ts";
import type { SurfaceItem } from "./surface.ts";
import type { TaskAcceptanceCriterion, TaskScope } from "./task.ts";

/** The propagation contract version this engine writes and reads. */
export type PropagationVersion = 1;

/** What one consumer declares it depends on. */
export type DependencyKind = "surface" | "behavior" | "collection" | "page" | "symbol" | "decision" | "evidence";

/**
 * One declared dependency. `id` is the stable id the upstream snapshot publishes: a surface item id such as
 * `api:greet`, a behavior id such as `install.runs`, a collection name, a page source path, a symbol, a decision id,
 * or an evidence id. `pages` and `files` scope the effect inside the consumer's own tree.
 */
export interface ConsumedDependency {
  readonly kind: DependencyKind;
  readonly id: string;
  /** Consumer-relative page sources or URLs the dependency affects. */
  readonly pages?: readonly string[];
  /** Consumer-relative files the dependency affects, with forward slashes. */
  readonly files?: readonly string[];
}

/** What a consumer asks the engine to prepare when a change of one severity affects it. */
export type PropagationAction = "none" | "acknowledge" | "task" | "pull-request" | "review";

/** How a consumer accepts an upstream snapshot version, and what each severity causes. */
export interface ConsumerVersionPolicy {
  /** An inclusive version range, such as `>=1.2.0 <2.0.0`; absent accepts the locked snapshot. */
  readonly range?: string;
  /** `pinned` accepts only the locked snapshot; `compatible` accepts one whose version satisfies `range`. */
  readonly channel?: "pinned" | "compatible";
  /** Default `acknowledge`. */
  readonly onCompatible?: PropagationAction;
  /** Default `task`. */
  readonly onBreaking?: PropagationAction;
  /** Default `review`. */
  readonly onReview?: PropagationAction;
}

/**
 * Which evidence a consumer may receive. Evidence ids are matched exactly; `*` allows every public id. `deny` wins
 * over `allow`, so a value the consumer is not authorized to read is withheld rather than redacted in place.
 */
export interface ConsumerEvidencePolicy {
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
}

/** Who must approve applying a change in the consumer's repository. */
export interface ConsumerApproval {
  /** `required` makes an apply return a pending approval and create no task until an approver is named. */
  readonly mode: "automatic" | "required";
  /** Principals who may approve; with `required`, empty means nobody can approve automatically. */
  readonly approvers: readonly string[];
}

/** One consumer project, the upstream project it depends on, and what it accepts. */
export interface ConsumerDeclaration {
  /** Stable consumer id, unique in the manifest. */
  readonly id: string;
  /** The upstream project id the consumer depends on. */
  readonly project: string;
  /** The consumer's own namespace, when it publishes a bundle. */
  readonly namespace?: string;
  readonly policy: ConsumerVersionPolicy;
  readonly approval: ConsumerApproval;
  readonly evidence: ConsumerEvidencePolicy;
  /** Every dependency whose change affects this consumer. */
  readonly consumes: readonly ConsumedDependency[];
}

/** The versioned consumer manifest, read from `propagation.json` or named with `--manifest`. */
export interface PropagationManifest {
  readonly version: PropagationVersion;
  /** Every consumer, in manifest order. */
  readonly consumers: readonly ConsumerDeclaration[];
}

/** One located manifest problem, with a JSON Pointer into the manifest. */
export interface PropagationProblem {
  /** A JSON Pointer such as `/consumers/0/policy/range`; `""` is the whole document. */
  readonly path: string;
  /** A stable code, such as `propagation.invalid-dependency`. */
  readonly code: string;
  readonly message: string;
}

/** A parsed manifest, or every reason it was refused. */
export interface PropagationManifestResult {
  readonly manifest?: PropagationManifest;
  readonly problems: readonly PropagationProblem[];
}

/** The access policy a locked snapshot publishes. */
export interface SnapshotPolicy {
  readonly public: boolean;
  readonly audiences: readonly string[];
}

/** One locked snapshot of an upstream project, as a diff reads it. */
export interface SnapshotView {
  readonly project: string;
  readonly namespace: string;
  readonly snapshot: {
    readonly id: string;
    readonly version: string;
  };
  readonly policy: SnapshotPolicy;
  readonly graph: Graph;
  readonly surface: readonly SurfaceItem[];
  readonly behaviors: readonly BehaviorRecord[];
  /** Public decision records, when the snapshot carries them. */
  readonly decisions?: readonly DecisionRecord[];
  /** The evidence the snapshot publishes, when it carries it. */
  readonly evidence?: FederationEvidenceBundle;
}

/** One snapshot's identity, without the data a preview does not need. */
export interface SnapshotIdentity {
  readonly project: string;
  readonly namespace: string;
  readonly snapshot: {
    readonly id: string;
    readonly version: string;
  };
}

/** The public subject a semantic change is about. */
export type ChangeSubject = "surface" | "behavior" | "decision" | "evidence";

/** How the subject changed. */
export type ChangeKind = "added" | "removed" | "signature" | "status" | "link" | "digest" | "scope";

/**
 * One versioned semantic change. `ref` is the stable dependency id a consumer declares, such as `api:greet` for a
 * surface item or `behavior:install.runs` for a behavior. `hash` is SHA-256 over the changed record, so a proposal can
 * name exactly the bytes it reacted to, and `external` is false for a change that no consumer can observe.
 */
export interface SemanticChange {
  readonly version: PropagationVersion;
  /** The upstream project the change belongs to, so two projects' same-named nodes stay distinct. */
  readonly project: string;
  readonly subject: ChangeSubject;
  readonly kind: ChangeKind;
  /** The dependency id: `api:greet`, `behavior:install.runs`, `decision:ADR-0001`, `evidence:claim-x`. */
  readonly ref: string;
  /** The record's own id inside the snapshot. */
  readonly record: string;
  /** Where the change is written upstream, when the record has a source position. */
  readonly source?: SourcePos;
  readonly hash: string;
  readonly before?: string;
  readonly after?: string;
  /** Consumer-relative page paths the changed record points at, so a page dependency can match. */
  readonly pages?: readonly string[];
  /** Upstream files the changed record names, so a file dependency can match. */
  readonly files?: readonly string[];
  /** True only when the change is part of the public contract a consumer can observe. */
  readonly external: boolean;
}

/** How a change relates to a consumer's version policy. */
export type ChangeSeverity = "compatible" | "breaking" | "review";

/** One declared dependency that an event affected. */
export interface AffectedDependency {
  readonly consumer: string;
  readonly project: string;
  readonly dependency: ConsumedDependency;
  readonly change: SemanticChange;
  readonly severity: ChangeSeverity;
}

/** One downstream snapshot a release affects: the consumer's current view of the upstream project. */
export interface DownstreamSnapshot {
  readonly project: string;
  readonly from?: string;
  readonly to: string;
}

/** What one consumer is asked to do about a proposed release. */
export interface ConsumerImpact {
  readonly consumer: string;
  readonly project: string;
  readonly snapshot: {
    readonly id: string;
    readonly version: string;
  };
  /** The strongest severity among the affected dependencies. */
  readonly severity: ChangeSeverity;
  readonly action: PropagationAction;
  readonly affected: readonly AffectedDependency[];
  /** The downstream snapshots the change reaches. */
  readonly snapshots: readonly DownstreamSnapshot[];
  /** The consumer pages the change reaches, sorted. */
  readonly pages: readonly string[];
  /** The deterministic task proposal ids the change produces. */
  readonly tasks: readonly string[];
  /** One sentence naming the change and the policy decision. */
  readonly reason: string;
}

/** One consumer that could not be evaluated, kept apart from the consumers that succeeded. */
export interface PropagationFailure {
  readonly consumer: string;
  readonly project: string;
  readonly kind: "missing-bundle" | "permission" | "invalid";
  /** One sentence naming what happened and what would change it, never a private value. */
  readonly reason: string;
}

/** The impact of a proposed upstream release, before anything is published. */
export interface PropagationPreview {
  readonly version: PropagationVersion;
  /** The baseline snapshots the diff read, sorted by project. */
  readonly baseline: readonly SnapshotIdentity[];
  /** The current snapshots the diff read, sorted by project. */
  readonly current: readonly SnapshotIdentity[];
  /** Every external semantic change across the diffed projects, in stable order. */
  readonly events: readonly SemanticChange[];
  /** Every consumer the change reaches, sorted by consumer id. */
  readonly consumers: readonly ConsumerImpact[];
  /** Consumers whose declared project did not change, sorted by consumer id. */
  readonly unaffected: readonly string[];
  /** Every consumer that could not be evaluated. */
  readonly failures: readonly PropagationFailure[];
  /** True when a bundle was missing, unreadable, or a consumer could not be evaluated. */
  readonly partial: boolean;
}

/** One piece of evidence a proposal may carry. */
export interface ProposalEvidence {
  readonly id: string;
  readonly project: string;
  readonly kind: string;
  readonly hash?: string;
  readonly url?: string;
}

/** One decision a proposal may cite, so a reviewer sees why the change happened. */
export interface ProposalDecision {
  readonly id: string;
  readonly reason: string;
  readonly source?: SourcePos;
}

/** One change a proposal reacts to, by its stable ref and hash. */
export interface ProposalChange {
  readonly ref: string;
  readonly hash: string;
}

/** One proposed downstream task. The upstream source is never written by this. */
export interface TaskProposal {
  readonly version: PropagationVersion;
  /** Deterministic id over the consumer, the upstream snapshot, and the change set. */
  readonly id: string;
  readonly consumer: string;
  /** The upstream snapshot the proposal reacts to. */
  readonly upstream: {
    readonly project: string;
    readonly snapshot: string;
    readonly version: string;
    /** SHA-256 over the change set the proposal reacts to. */
    readonly change: string;
  };
  readonly severity: ChangeSeverity;
  readonly action: PropagationAction;
  readonly goal: string;
  readonly scope: TaskScope;
  readonly acceptance: readonly TaskAcceptanceCriterion[];
  /** Why the consumer must change, in one sentence. */
  readonly rationale: string;
  /** The decisions that explain the change, when the snapshot carries them. */
  readonly decisions: readonly ProposalDecision[];
  /** The evidence the consumer is authorized to read. */
  readonly evidence: readonly ProposalEvidence[];
  /** How many evidence items the consumer's policy withheld. */
  readonly withheldEvidence: number;
  readonly changes: readonly ProposalChange[];
}

/** What a receipt records about one consumer's processing. */
export type PropagationReceiptStatus = "proposed" | "pending-approval" | "applied" | "verified" | "noop" | "failed";

/** One deterministic receipt. It holds no timestamp, so reprocessing the same snapshots writes the same bytes. */
export interface PropagationReceipt {
  readonly version: PropagationVersion;
  /** SHA-256 over the consumer, the upstream snapshot, and the change set. */
  readonly id: string;
  readonly consumer: string;
  readonly upstream: {
    readonly project: string;
    readonly snapshot: string;
    readonly version: string;
    readonly change: string;
  };
  readonly severity: ChangeSeverity;
  readonly action: PropagationAction;
  readonly status: PropagationReceiptStatus;
  /** The task proposal ids the receipt produced. */
  readonly tasks: readonly string[];
  /** A prepared pull-request reference, when the action asks for one. */
  readonly pullRequest?: string;
  readonly requiresApproval: boolean;
  /** The principals who approved the change, sorted. */
  readonly approvedBy: readonly string[];
  /** Why the receipt ended in its status, in one sentence. */
  readonly reason: string;
}

/** The local ledger of receipts, read and written beside the site. */
export interface PropagationLedger {
  readonly version: PropagationVersion;
  /** Sorted by receipt id. */
  readonly receipts: readonly PropagationReceipt[];
}

/** What applying a proposed release returned. */
export interface PropagationApplyResult {
  readonly version: PropagationVersion;
  /** The ledger after this run, with every earlier receipt kept. */
  readonly ledger: PropagationLedger;
  /** Every receipt for this run, including reused earlier receipts, sorted by id. */
  readonly receipts: readonly PropagationReceipt[];
  /** The task proposals this run created, in consumer order. */
  readonly tasks: readonly TaskProposal[];
  /** The receipt ids that already existed and were returned unchanged. */
  readonly reused: readonly string[];
  /** The receipt ids this run created. */
  readonly created: readonly string[];
  readonly failures: readonly PropagationFailure[];
  readonly partial: boolean;
}

/** How a stored receipt is marked after its downstream task verifies. */
export interface PropagationVerification {
  readonly receipt: PropagationReceipt;
  /** True when the receipt was already `verified` or `applied` and was left unchanged. */
  readonly unchanged: boolean;
}
