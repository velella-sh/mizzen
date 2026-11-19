/**
 * The versioned agent-evaluation contract: one suite, its cases, the output a runner returns, the
 * scored report, and the baseline comparison.
 *
 * A case names what the agent is asked to do, the fixture it runs against, the snapshot and tools
 * it pins, the permissions and budget it has, the acceptance criteria it must meet, and the outcome
 * a correct agent produces. A run records the Mizzen version, package, fixture, config, and pack it
 * actually used, so two reports are comparable only when every pin agrees.
 *
 * Scoring is separate by component (task success, evidence, scope, checks, and efficiency) and the
 * weights are published in {@link EVAL_RUBRIC_WEIGHTS}. A security violation is reported outside
 * the aggregate and fails the case however high the weighted score is.
 */

/** The case format version. Only 1 exists. */
export const EVAL_CASE_VERSION = 1;

/** The suite format version. Only 1 exists. */
export const EVAL_SUITE_VERSION = 1;

/** The report format version. Only 1 exists. */
export const EVAL_REPORT_VERSION = 1;

/** The baseline format version. Only 1 exists. */
export const EVAL_BASELINE_VERSION = 1;

/** The scoring rubric version, reported with every score so an old number is never read as a new one. */
export const EVAL_RUBRIC_VERSION = 1;

/** The published component weights. They sum to 1 and never include a security discount. */
export const EVAL_RUBRIC_WEIGHTS = {
  success: 0.4,
  evidence: 0.2,
  scope: 0.15,
  checks: 0.15,
  efficiency: 0.1,
} as const;

/** One scored component. */
export type EvalComponent = keyof typeof EVAL_RUBRIC_WEIGHTS;

/** The capability a case measures. */
export type EvalCapability =
  | "discovery"
  | "answer"
  | "context"
  | "edit"
  | "transaction"
  | "verification"
  | "handoff"
  | "conflict"
  | "permission";

/** A tool and the version a case or run pins. */
export interface EvalToolPin {
  readonly name: string;
  readonly version: string;
}

/** The task-level permission strings a case runs under. */
export interface EvalPermissions {
  readonly read: readonly string[];
  readonly write: readonly string[];
  readonly check: readonly string[];
}

/** What one case may spend. */
export interface EvalBudget {
  readonly maxTokens: number;
  readonly maxToolCalls: number;
}

/** One acceptance criterion of a case. */
export interface EvalCriterion {
  readonly id: string;
  readonly statement: string;
}

/** A source span in the units of the engine's source positions: 1-based, inclusive end. */
export interface EvalSpan {
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
}

/** The files a capability-specific case reads besides its site fixture. */
export interface EvalCaseInputs {
  /** A recorded agent output, relative to the suite. */
  readonly agent?: string;
  /** An access policy, relative to the suite. */
  readonly policy?: string;
  /** An edit transaction, relative to the suite. */
  readonly transaction?: string;
  /** A verification proof, relative to the suite. */
  readonly proof?: string;
  /** The public evidence an independent verifier reads, relative to the suite. */
  readonly input?: string;
  /** A public handoff document, relative to the suite. */
  readonly handoff?: string;
  /** The parent split request a coordination case hands to the splitter, relative to the suite. */
  readonly split?: string;
}

/** One recorded edit: the span the agent chose, the text it expected, and its replacement. */
export interface EvalEdit {
  readonly path: string;
  readonly span: EvalSpan;
  readonly expected: string;
  readonly replacement: string;
}

/** The expected outcome of one capability. The `kind` must equal the case's `capability`. */
export type EvalExpectation =
  | {
      readonly kind: "discovery";
      /** Source paths the agent must find. */
      readonly pages: readonly string[];
      /** Exported symbols the agent must find. */
      readonly symbols: readonly string[];
    }
  | {
      readonly kind: "answer";
      readonly answer: string;
      /** Incisive citations as `path` or `path:line`. */
      readonly citations: readonly string[];
      /** Sources a correct answer must not cite. */
      readonly forbidden: readonly string[];
    }
  | {
      readonly kind: "context";
      /** Block ids, record ids, or source paths the pack must contain. */
      readonly evidence: readonly string[];
      readonly pages: readonly string[];
      readonly maxPages: number;
    }
  | {
      readonly kind: "edit";
      readonly path: string;
      readonly spans: readonly EvalSpan[];
      /** The whole target file after the edit. */
      readonly after: string;
      /** Text that must survive unchanged, with the file it lives in. */
      readonly unchanged: readonly { readonly path: string; readonly text: string }[];
    }
  | {
      readonly kind: "transaction";
      readonly outcome: "applied" | "rejected";
      /** The invariant that must be reported, or `null` when none is expected. */
      readonly invariant: string | null;
      readonly attempted: readonly string[];
      readonly changed: readonly string[];
    }
  | {
      readonly kind: "verification";
      /** The verdict independent verification must reach. */
      readonly verdict: "proved" | "failed";
    }
  | {
      readonly kind: "handoff";
      readonly nextAction: string;
      readonly applied: readonly string[];
      readonly remaining: readonly string[];
      readonly duplicateRefused: boolean;
    }
  | {
      readonly kind: "conflict";
      readonly overlap: readonly string[];
      readonly resolution: "rejected" | "approved";
    }
  | {
      readonly kind: "permission";
      readonly attempts: readonly {
        readonly capability: "read" | "write" | "execute" | "network" | "publish";
        readonly target: string;
      }[];
    };

/** One evaluation case. */
export interface EvalCase {
  readonly version: typeof EVAL_CASE_VERSION;
  /** Stable id, unique in the suite; also the report's case key. */
  readonly id: string;
  readonly title: string;
  readonly capability: EvalCapability;
  /** What the agent is asked to do, in one sentence. */
  readonly goal: string;
  /** The site fixture folder, relative to the suite. */
  readonly fixture: string;
  /** The fixture snapshot label this case was written for. */
  readonly snapshot: string;
  readonly permissions: EvalPermissions;
  readonly budget: EvalBudget;
  readonly criteria: readonly EvalCriterion[];
  readonly tools: readonly EvalToolPin[];
  readonly inputs?: EvalCaseInputs;
  readonly expected?: EvalExpectation;
  /** Why a capability could not be evaluated yet; a case with a reason is never scored as a pass. */
  readonly unavailable?: string;
}

/** One case path in a suite. */
export interface EvalSuitePins {
  /** The engine version the cases were written against. */
  readonly mizzen?: string;
  /** The tool versions a runner must provide. */
  readonly tools?: readonly EvalToolPin[];
  /** The package pin a comparable run must use, such as a tarball SHA-256 or `source`. */
  readonly package?: string;
}

/** One evaluation suite: a versioned list of case files and the environment they pin. */
export interface EvalSuite {
  readonly version: typeof EVAL_SUITE_VERSION;
  readonly id: string;
  readonly cases: readonly string[];
  readonly pins: EvalSuitePins;
}

/** One located problem in a case or suite. `path` is a JSON Pointer into the parsed document. */
export interface EvalProblem {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

/** A parsed case, or every reason it was refused. */
export interface EvalCaseParseResult {
  readonly case?: EvalCase;
  readonly problems: readonly EvalProblem[];
}

/** A parsed suite, or every reason it was refused. */
export interface EvalSuiteParseResult {
  readonly suite?: EvalSuite;
  readonly problems: readonly EvalProblem[];
}

/** One access attempt an agent made, with everything `decideAccess` needs. */
export interface EvalAccessAttempt {
  readonly capability: "read" | "write" | "execute" | "network" | "publish";
  /** A display target; it is also the path, resource id, runner, or destination when the specific field is absent. */
  readonly target: string;
  readonly resource?: { readonly kind: "page" | "block" | "collection" | "record" | "field" | "audience" | "other"; readonly id: string; readonly page?: string; readonly collection?: string; readonly field?: string; readonly audiences?: readonly string[] };
  readonly path?: string;
  readonly runner?: string;
  readonly destination?: string;
  readonly stage?: "build" | "verify" | "replay" | "publish";
}

/** One tool call the runner reports. */
export interface EvalToolCall {
  readonly name: string;
  readonly version: string;
  readonly ok: boolean;
}

/** The usage a runner reports; it must agree with its trace totals. */
export interface EvalUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** The totals a recorded trace reports, used to check the usage above. */
export interface EvalTraceTotals {
  readonly toolCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** One changed file a transaction attempted. */
export interface EvalTransactionOutput {
  readonly status: "applied" | "rejected";
  readonly attempted: readonly string[];
  readonly changed: readonly string[];
  /** Files whose bytes are unchanged after the attempt. */
  readonly unchanged: readonly string[];
  readonly invariant?: string;
  /** True when any file was left half-changed. */
  readonly partial: boolean;
  readonly checks: readonly { readonly id: string; readonly status: string }[];
}

/** The independent-verification evidence a case records. */
export interface EvalVerificationOutput {
  readonly ok: boolean;
  readonly verdict: "proved" | "incomplete" | "failed";
  readonly producerVerdict: "proved" | "incomplete" | "failed";
  readonly agrees: boolean;
  readonly proofHash: "matched" | "mismatched";
  readonly checked: {
    readonly files: number;
    readonly checks: number;
    readonly outputs: boolean;
    readonly humanReview: boolean;
    readonly package: boolean;
  };
  readonly failures: readonly { readonly code: string; readonly message: string }[];
}

/** What a runner returns for one case. */
export interface EvalAgentOutput {
  readonly pages: readonly string[];
  readonly symbols: readonly string[];
  readonly answer?: { readonly text: string; readonly citations: readonly string[] };
  readonly context?: {
    readonly refs: readonly string[];
    readonly pages: readonly string[];
    readonly fragments: number;
    readonly tokens: number;
  };
  readonly edits?: readonly EvalEdit[];
  readonly transaction?: EvalTransactionOutput;
  readonly handoff?: {
    readonly nextAction: string;
    readonly applied: readonly string[];
    readonly remaining: readonly string[];
    readonly duplicateRefused: boolean;
  };
  readonly conflict?: {
    readonly detected: boolean;
    readonly overlap: readonly string[];
    readonly resolution: "rejected" | "approved" | "none";
  };
  readonly permission?: { readonly attempts: readonly EvalAccessAttempt[] };
  readonly verification?: EvalVerificationOutput;
  readonly toolCalls: readonly EvalToolCall[];
  readonly usage: EvalUsage;
  readonly trace?: EvalTraceTotals;
  /** Files the agent read; reading beyond the case's pack lowers efficiency. */
  readonly readFiles?: readonly string[];
}

/** One scored component, each from 0 to 1. */
export type EvalComponents = Readonly<Record<EvalComponent, number>>;

/** The pins one case run recorded. */
export interface EvalCasePins {
  /** SHA-256 of the fixture tree. */
  readonly fixture: string;
  /** SHA-256 of the fixture's `mizzen.yml`. */
  readonly config: string;
  /** The context cache key the case goal compiled to, or `none` when no pack was compiled. */
  readonly pack: string;
  /** SHA-256 of the recorded agent output, or `none`. */
  readonly agent: string;
}

/** The environment pins one run recorded. */
export interface EvalRunPins {
  readonly mizzen: string;
  readonly package: string;
  readonly tools: readonly EvalToolPin[];
}

/** One finding that explains a score, an invalidation, or a refusal. */
export interface EvalFinding {
  readonly code: string;
  readonly message: string;
}

/** The metrics a case reports. */
export interface EvalMetrics {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly tokens: number;
  readonly toolCalls: number;
  readonly budgetTokens: number;
  readonly budgetToolCalls: number;
  readonly contextTokens: number;
  readonly contextPages: number;
}

/** The evidence a case result keeps, so a reader never has to rerun it to see why. */
export interface EvalCaseEvidence {
  readonly pages: readonly string[];
  readonly symbols: readonly string[];
  readonly citations: readonly string[];
  readonly refs: readonly string[];
  readonly files: readonly string[];
  readonly checks: readonly { readonly id: string; readonly status: string }[];
  readonly verifier?: EvalVerificationOutput;
}

/** One criterion and whether the result satisfied it. */
export interface EvalCriterionResult {
  readonly id: string;
  readonly statement: string;
  readonly satisfied: boolean;
}

/** How one case ended. `invalid` means its pins or its report cannot be compared; `unavailable` is a known gap. */
export type EvalCaseStatus = "passed" | "failed" | "invalid" | "unavailable";

/** One scored case. */
export interface EvalCaseResult {
  readonly version: typeof EVAL_REPORT_VERSION;
  readonly id: string;
  readonly title: string;
  readonly capability: EvalCapability;
  readonly status: EvalCaseStatus;
  readonly snapshot: string;
  readonly pins: EvalCasePins;
  readonly runner: { readonly id: string; readonly version: string; readonly model?: string };
  readonly components: EvalComponents;
  /** The weighted total over the published rubric. */
  readonly weighted: number;
  readonly security: "ok" | "violation";
  readonly criteria: readonly EvalCriterionResult[];
  readonly metrics: EvalMetrics;
  readonly evidence: EvalCaseEvidence;
  readonly findings: readonly EvalFinding[];
  readonly unavailable?: string;
}

/** The rubric as published with a report. */
export interface EvalRubric {
  readonly version: typeof EVAL_RUBRIC_VERSION;
  readonly weights: typeof EVAL_RUBRIC_WEIGHTS;
  /** The one component an aggregate cannot hide. */
  readonly critical: "security";
}

/** The totals of one suite run. */
export interface EvalTotals {
  readonly cases: number;
  readonly passed: number;
  readonly failed: number;
  readonly invalid: number;
  readonly unavailable: number;
  /** The mean weighted score over every case that was scored. */
  readonly weighted: number;
  readonly metrics: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly tokens: number;
    readonly toolCalls: number;
  };
}

/** One case's line in a baseline document. */
export interface EvalBaselineCase {
  readonly id: string;
  readonly status: EvalCaseStatus;
  readonly weighted: number;
  readonly components: EvalComponents;
  readonly metrics: EvalMetrics;
  readonly pins: EvalCasePins;
}

/** A recorded run that later runs compare with. */
export interface EvalBaseline {
  readonly version: typeof EVAL_BASELINE_VERSION;
  readonly suite: { readonly id: string; readonly version: number };
  readonly runner: { readonly id: string; readonly version: string; readonly model?: string };
  readonly pins: EvalRunPins;
  readonly cases: readonly EvalBaselineCase[];
}

/** One case's change against the baseline. */
export interface EvalBaselineDelta {
  readonly id: string;
  readonly status: "regressed" | "improved" | "unchanged" | "incomparable" | "new" | "removed";
  readonly weighted: number;
  readonly previous: number;
  readonly delta: number;
  readonly tokens: number;
  readonly previousTokens: number;
  readonly toolCalls: number;
  readonly previousToolCalls: number;
  /** Why a case cannot be compared, when it cannot. */
  readonly reason?: string;
}

/** The comparison of one report with a baseline. */
export interface EvalBaselineComparison {
  readonly comparable: boolean;
  readonly reasons: readonly string[];
  readonly cases: readonly EvalBaselineDelta[];
  readonly weighted: number;
  readonly previous: number;
  readonly delta: number;
  readonly regressed: readonly string[];
}

/** Whether the deterministic gate passed, and why. */
export interface EvalGate {
  readonly passed: boolean;
  readonly reasons: readonly string[];
  readonly scored: number;
  readonly unavailable: readonly string[];
}

/** One suite run. It holds no clock, so the same inputs give the same bytes. */
export interface EvalReport {
  readonly version: typeof EVAL_REPORT_VERSION;
  readonly suite: { readonly id: string; readonly version: number };
  readonly run: { readonly id: string; readonly runner: { readonly id: string; readonly version: string; readonly model?: string }; readonly package: string };
  readonly pins: EvalRunPins;
  readonly rubric: EvalRubric;
  readonly cases: readonly EvalCaseResult[];
  readonly totals: EvalTotals;
  readonly gate: EvalGate;
  readonly baseline?: EvalBaselineComparison;
}

/** What {@link runEvalSuite} needs. */
export interface EvalRunOptions {
  /** The suite file, or the folder holding `suite.json`. */
  readonly suite: string;
  /** The package pin to record; `source` when running from a checkout. */
  readonly package?: string;
  /** A recorded baseline to compare with. */
  readonly baseline?: EvalBaseline;
  /** A comparison that cannot find a pinned match is an error, not a warning. */
  readonly strictBaseline?: boolean;
}
