/**
 * Coverage-driven authoring: a documentation gap becomes a versioned authoring task with the public surface,
 * introduction version, required evidence, recommended page type, and evidence-first outline. An external agent
 * exports the task and its context pack, returns a draft, and the engine validates the draft's citations, explicit
 * unknowns, location, preview, checks, and pull-request proposal before anything is written.
 *
 * Everything here is data. No function in `../authoring/` calls a model; draft generation is the external agent's
 * job, and the engine only exports the task, validates the returned draft, runs the checks, and prepares a reviewable
 * proposal. The same inputs give the same bytes on every machine.
 */
import type { SourcePos } from "./source.ts";
import type { SurfaceArea, SurfaceGapKind, SurfaceItemKind, SurfaceStability } from "./surface.ts";
import type { TaskDocument } from "./task.ts";

/** The authoring format this engine writes and reads. */
export type AuthoringVersion = 1;

/** The page type the rules recommend for one gap. */
export type AuthoringPageType = "reference" | "guide" | "example" | "runbook";

/** What a reader comes to the page to do, which decides the page type. */
export type AuthoringPurpose = "lookup" | "describe" | "demonstrate" | "operate";

/** What a claim or outline section may cite. */
export type AuthoringEvidenceKind = "surface" | "behavior" | "test" | "example" | "evidence" | "source";

/** The fixed outline sections, in the order a draft writes them. */
export type AuthoringOutlineKind = "behavior" | "prerequisites" | "example" | "limitations" | "references";

/** One piece of evidence the task requires the draft to cite. */
export interface AuthoringEvidenceRef {
  readonly kind: AuthoringEvidenceKind;
  /** The surface id, behavior id, test path, evidence id or URL, or `file:line` reference. */
  readonly ref: string;
  /** Why the evidence is required, in one sentence. */
  readonly detail: string;
}

/** One explicit unknown the draft must carry forward. */
export interface AuthoringUnknown {
  /** A stable id, such as `version-introduced` or `behavior-contract`. */
  readonly id: string;
  /** What is not known, in one sentence. */
  readonly statement: string;
  /** The evidence that would settle it, when one is named. */
  readonly evidence?: string;
}

/** One question a human reviewer must answer before the page is trusted. */
export interface AuthoringQuestion {
  readonly id: string;
  /** The question, in one sentence. */
  readonly question: string;
}

/** The recommended page type, with the purpose and the rules that produced it. */
export interface AuthoringPageTypeChoice {
  readonly kind: AuthoringPageType;
  readonly purpose: AuthoringPurpose;
  /** One sentence naming the surface item, the purpose, and the page type. */
  readonly reason: string;
  /** The rule ids that matched, in the order they were applied. */
  readonly rules: readonly string[];
}

/** Where the proposed page sits in the navigation. */
export interface AuthoringNavPlacement {
  /** The navigation list, such as `docs`. */
  readonly list: string;
  /** The link title. */
  readonly title: string;
  /** The group title the page sits under, when one is proposed. */
  readonly parent?: string;
  /** The title of the sibling the page follows, when one is proposed. */
  readonly after?: string;
}

/** The proposed stable URL, source path, block id, and navigation placement. */
export interface AuthoringLocation {
  /** The output URL under the site base, such as `/reference/parse-widget/`. */
  readonly url: string;
  /** The source path relative to the site root, such as `docs/reference/parse-widget.md`. */
  readonly source: string;
  /** The block id the page's first heading declares. */
  readonly block: string;
  readonly nav: AuthoringNavPlacement;
}

/** Why a proposed URL, block id, or navigation placement cannot be used. */
export type AuthoringConflictKind = "slug" | "block" | "nav";

/** One location conflict, rejected before anything is written. */
export interface AuthoringConflict {
  readonly kind: AuthoringConflictKind;
  /** The URL, block id, or navigation title that conflicts. */
  readonly value: string;
  readonly message: string;
}

/** One outline section, with the evidence it already has and what it still needs. */
export interface AuthoringOutlineSection {
  readonly kind: AuthoringOutlineKind;
  readonly heading: string;
  /** What the section must state, one sentence per point. */
  readonly points: readonly string[];
  /** The evidence the section already has. */
  readonly evidence: readonly AuthoringEvidenceRef[];
  /** True when the section cannot be completed from the present evidence. */
  readonly needsEvidence: boolean;
  /** Why it needs evidence, when it does. */
  readonly needsEvidenceReason?: string;
}

/** The public surface item a task is written for, kept whole so the task is actionable without the report. */
export interface AuthoringSurfaceItem {
  readonly id: string;
  readonly area: SurfaceArea;
  readonly kind: SurfaceItemKind;
  readonly name: string;
  readonly stability: SurfaceStability;
  readonly source: SourcePos;
  readonly signature?: string;
  /** The product version that introduced the item, or `unknown`. */
  readonly introduced: string;
}

/** One authoring task: the registered task and every product fact the draft must respect. */
export interface AuthoringTask {
  readonly version: AuthoringVersion;
  /** The registered task, with its snapshot, budget, permissions, and acceptance criteria. */
  readonly task: TaskDocument;
  /** The public surface id, such as `symbol:parseWidget`. */
  readonly item: string;
  /** The item, with its declaration span and introduction version. */
  readonly surface: AuthoringSurfaceItem;
  /** Whether the item had no documentation or only weak documentation. */
  readonly gap: SurfaceGapKind;
  /** The evidence the draft must cite. */
  readonly requiredEvidence: readonly AuthoringEvidenceRef[];
  readonly pageType: AuthoringPageTypeChoice;
  readonly outline: readonly AuthoringOutlineSection[];
  readonly location: AuthoringLocation;
  /** Explicit unknowns the draft must carry forward. */
  readonly unknowns: readonly AuthoringUnknown[];
  /** Questions a human reviewer must answer. */
  readonly questions: readonly AuthoringQuestion[];
  /** Limitations the draft must keep. */
  readonly limitations: readonly string[];
  /** Location conflicts found before anything is written; non-empty means the task cannot be drafted as proposed. */
  readonly conflicts: readonly AuthoringConflict[];
}

/** One documented exclusion that produced no task. */
export interface AuthoringSkip {
  readonly item: string;
  /** Why no task was created; an exclusion is never a gap. */
  readonly reason: string;
}

/** The versioned task list `mizzen author tasks` prints. */
export interface AuthoringTaskList {
  readonly version: AuthoringVersion;
  readonly source: { readonly version?: string };
  /** Tasks sorted by surface id. */
  readonly tasks: readonly AuthoringTask[];
  /** Documented exclusions and other items that produced no task, sorted by item. */
  readonly skipped: readonly AuthoringSkip[];
}

/** One citation marker found in a draft, such as `[[surface:symbol:parseWidget]]`. */
export interface AuthoringCitation {
  readonly kind: AuthoringEvidenceKind;
  readonly ref: string;
  /** One-based line in the draft body. */
  readonly line: number;
  /** The claim text the citation is attached to. */
  readonly claim: string;
}

/** One paragraph of a draft, whether it states a normative claim, and the citations on it. */
export interface AuthoringClaim {
  readonly text: string;
  /** One-based line where the paragraph starts. */
  readonly line: number;
  /** True when the paragraph uses a normative verb, such as `returns`, `requires`, or `must`. */
  readonly normative: boolean;
  readonly citations: readonly AuthoringCitation[];
}

/** One reason a draft was refused. */
export interface AuthoringProblem {
  /** JSON Pointer to the offending value, or the draft body line. */
  readonly path: string;
  /** Stable identifier, such as `authoring.uncited-claim`. */
  readonly code: string;
  readonly message: string;
}

/** A draft returned by an external agent. */
export interface AuthoringDraft {
  readonly version: 1;
  /** The public surface id the draft documents. */
  readonly item: string;
  readonly pageType: AuthoringPageType;
  readonly title: string;
  readonly description?: string;
  /** The proposed output URL, such as `/reference/parse-widget/`. */
  readonly slug: string;
  /** The block id the first heading declares. */
  readonly block: string;
  /** The Markdown body, with `[[kind:ref]]` citation markers. */
  readonly body: string;
  /** Limitations the page must state. */
  readonly limitations: readonly string[];
  /** Explicit unknowns carried forward from the task. */
  readonly unknowns: readonly AuthoringUnknown[];
  /** Questions for the human reviewer. */
  readonly questions: readonly AuthoringQuestion[];
}

/** The parsed draft, or every reason it is not one. */
export interface AuthoringDraftResult {
  readonly draft?: AuthoringDraft;
  readonly problems: readonly AuthoringProblem[];
}

/** The validation of one draft against its task and the site. */
export interface AuthoringDraftValidation {
  readonly version: AuthoringVersion;
  readonly item: string;
  readonly draft?: AuthoringDraft;
  readonly pageType?: AuthoringPageType;
  /** Every paragraph, in document order. */
  readonly claims: readonly AuthoringClaim[];
  /** Every citation, in document order. */
  readonly citations: readonly AuthoringCitation[];
  /** The normative paragraphs with no citation; a non-empty list blocks the preview. */
  readonly uncited: readonly AuthoringClaim[];
  readonly problems: readonly AuthoringProblem[];
  readonly conflicts: readonly AuthoringConflict[];
  readonly unknowns: readonly AuthoringUnknown[];
  readonly questions: readonly AuthoringQuestion[];
  readonly limitations: readonly string[];
  /** True only when there is no problem, no uncited claim, and no conflict. */
  readonly ok: boolean;
}

/** Whether writing the page is allowed, and why. */
export type AuthoringWriteGate = "denied" | "requires-approval" | "allowed";

/** The built page a preview shows. */
export interface AuthoringPreviewPage {
  /** The source path the preview built, relative to the site root. */
  readonly source: string;
  /** The output URL under the site base. */
  readonly url: string;
  /** The output file relative to the build output, such as `reference/parse-widget/index.html`. */
  readonly file: string;
  readonly html: string;
  /** The Markdown source a reader can compare with the built page. */
  readonly markdown: string;
}

/** A preview: the built page, the source diff, the citation list, and the write gate. */
export interface AuthoringPreview {
  readonly version: AuthoringVersion;
  readonly item: string;
  readonly task: string;
  readonly source: string;
  readonly url: string;
  readonly block: string;
  readonly page?: AuthoringPreviewPage;
  /** The unified diff between the existing file, if any, and the draft. */
  readonly diff: string;
  readonly claims: readonly AuthoringClaim[];
  readonly citations: readonly AuthoringCitation[];
  /** Normative claims with no citation, reported before the preview is built. */
  readonly uncited: readonly AuthoringClaim[];
  readonly unknowns: readonly AuthoringUnknown[];
  readonly questions: readonly AuthoringQuestion[];
  readonly limitations: readonly string[];
  readonly write: AuthoringWriteGate;
  readonly writeReason: string;
  readonly problems: readonly AuthoringProblem[];
}

/** One check a verification ran. */
export type AuthoringCheckKind = "citations" | "examples" | "behaviors" | "links" | "coverage" | "build";

/** How one check ended. `skipped` is never a pass. */
export type AuthoringCheckStatus = "passed" | "failed" | "skipped";

/** The result of one check. */
export interface AuthoringCheck {
  readonly id: string;
  readonly kind: AuthoringCheckKind;
  readonly status: AuthoringCheckStatus;
  /** One stable sentence about a failure or skip; never raw output. */
  readonly detail?: string;
}

/** The deterministic proof of one verification. */
export interface AuthoringProof {
  readonly version: 1;
  readonly item: string;
  readonly task: string;
  readonly snapshot: string;
  /** Every citation the draft used. */
  readonly citations: readonly AuthoringCitation[];
  readonly checks: readonly AuthoringCheck[];
  /** True when the simulated merge documents the item completely. */
  readonly gapClosed: boolean;
  /** SHA-256 over the proof without this field. */
  readonly hash: string;
}

/** The verification of one draft. */
export interface AuthoringVerification {
  readonly version: AuthoringVersion;
  readonly item: string;
  readonly task: string;
  readonly snapshot: string;
  readonly checks: readonly AuthoringCheck[];
  readonly proof?: AuthoringProof;
  readonly uncited: readonly AuthoringClaim[];
  /** Explicit unknowns that survive the checks, including any a failed behavior check added. */
  readonly remainingUnknowns: readonly AuthoringUnknown[];
  readonly remainingQuestions: readonly AuthoringQuestion[];
  /** The reason the draft is not ready, one sentence each. */
  readonly failures: readonly string[];
  /** `proved` only when every check passed and the proof was built. */
  readonly verdict: "proved" | "incomplete" | "failed";
  /** True only for `proved`. */
  readonly ready: boolean;
}

/** One file the proposal would write. */
export interface AuthoringProposalFile {
  readonly path: string;
  readonly sha256: string;
  readonly content: string;
}

/** A reviewable pull-request proposal; it is data, and no function opens the pull request. */
export interface AuthoringProposal {
  readonly version: 1;
  /** SHA-256 over the branch, files, both bodies, and proof hash. */
  readonly id: string;
  readonly item: string;
  readonly task: string;
  readonly branch: string;
  readonly base: string;
  readonly title: string;
  readonly body: string;
  readonly commitMessage: string;
  /** The page and navigation files the proposal would write, sorted by path. */
  readonly files: readonly AuthoringProposalFile[];
  readonly labels: readonly string[];
  /** Every check the verification passed. */
  readonly checks: readonly string[];
  readonly proofHash: string;
  /** Explicit unknowns a reviewer still has to settle. */
  readonly remainingUnknowns: readonly AuthoringUnknown[];
  readonly remainingQuestions: readonly AuthoringQuestion[];
  readonly permissions: {
    readonly contents: "write";
    readonly pullRequests: "write";
    readonly publish: false;
    readonly merge: false;
  };
  /** True when the verification is not proved; no branch or pull request is proposed. */
  readonly noop: boolean;
  readonly noopReason?: string;
}

/** The exported task and context pack an external agent reads. */
export interface AuthoringExport {
  readonly version: AuthoringVersion;
  readonly task: AuthoringTask;
  readonly pack: {
    /** The ready-to-paste Markdown pack. */
    readonly markdown: string;
    readonly accounting: {
      readonly requested: number;
      readonly used: number;
      readonly remaining: number;
      readonly upper: number;
      readonly method: string;
    };
    readonly answerability: {
      readonly complete: boolean;
      readonly shortages: readonly string[];
    };
    readonly omissions: readonly {
      readonly ref: string;
      readonly reason: string;
      readonly detail: string;
      readonly answers?: readonly string[];
    }[];
    readonly requests: readonly {
      readonly kind: string;
      readonly ref: string;
      readonly detail: string;
      readonly action: string;
    }[];
    readonly fragments: readonly {
      readonly id: string;
      readonly title: string;
      readonly source: { readonly file: string; readonly span: string; readonly block?: string; readonly record?: string; readonly snapshot: string };
      readonly tokens: number;
      readonly content: string;
    }[];
    /** The exact evidence the draft must cite, with the source text when it is local. */
    readonly evidence: readonly {
      readonly kind: AuthoringEvidenceKind;
      readonly ref: string;
      readonly detail: string;
      /** The local file the evidence was read from, when it is one. */
      readonly file?: string;
      /** The span the evidence names, when it has one. */
      readonly span?: string;
      /** The source text, when the evidence is local and readable. */
      readonly content?: string;
    }[];
  };
}

/** The result of writing a validated, approved draft. */
export interface AuthoringWriteResult {
  readonly written: boolean;
  /** The source path written, relative to the site root; absent when nothing was written. */
  readonly path?: string;
  /** The write gate that decided it. */
  readonly gate: AuthoringWriteGate;
  readonly reason: string;
  /** The preview the approval was for, so a caller can show the exact page and diff. */
  readonly preview?: AuthoringPreview;
}
