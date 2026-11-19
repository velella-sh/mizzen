import type { SourcePos } from "./source.ts";

/** The seven public readiness dimensions, in report order. */
export type ReadinessDimension =
  | "structure"
  | "navigation"
  | "context"
  | "examples"
  | "verification"
  | "permissions"
  | "maintenance";

/** How a rule, dimension, or whole report came out. `unknown` is never a pass. */
export type ReadinessStatus = "pass" | "fail" | "unknown";

/** How bad a finding is for readers and gates. */
export type ReadinessSeverity = "error" | "warning" | "info";

/** What a finding is about. `site` findings are systemic; the rest are local. */
export interface ReadinessScope {
  /** The kind of thing the finding names. */
  readonly kind: "site" | "page" | "block" | "collection" | "symbol";
  /** Output URL, without the site base, when the finding is local to a page. */
  readonly page?: string;
  /** Stable block id, when the finding names one. */
  readonly block?: string;
  /** Collection name, when the finding names one. */
  readonly collection?: string;
  /** Symbol name, when the finding names one. */
  readonly symbol?: string;
  /** True for a finding about the whole site rather than one page or record. */
  readonly systemic: boolean;
}

/** What a reader or agent should do about one finding. */
export interface ReadinessRemediation {
  /** A concrete action in one sentence. */
  readonly action: string;
  /** Stable documentation link for the rule. */
  readonly link: string;
}

/** One problem the readiness scan found, with its rule, place, and evidence. */
export interface ReadinessFinding {
  /** Stable rule code, such as `structure.sourcemap`. */
  readonly code: string;
  /** The dimension the rule scores. */
  readonly dimension: ReadinessDimension;
  /** How bad the finding is. */
  readonly severity: ReadinessSeverity;
  /** Where the finding sits. */
  readonly scope: ReadinessScope;
  /** The source span, when the finding has one. */
  readonly pos?: SourcePos;
  /** What was observed, without page text, prompts, or machine paths. */
  readonly evidence: string;
  /** What is wrong, in one sentence. */
  readonly message: string;
  /** What to do next. */
  readonly remediation: ReadinessRemediation;
}

/** One rule's outcome for the whole build. */
export interface ReadinessRuleResult {
  /** Stable rule code. */
  readonly code: string;
  /** The dimension the rule scores. */
  readonly dimension: ReadinessDimension;
  /** The rule's points inside its dimension. */
  readonly weight: number;
  /** `unknown` when a prerequisite is missing; it is left out of the score. */
  readonly status: ReadinessStatus;
  /** Why the rule is unknown, when it is. */
  readonly reason?: string;
}

/** One dimension's score and counts. */
export interface ReadinessDimensionScore {
  /** The dimension's name. */
  readonly dimension: ReadinessDimension;
  /** The dimension's weight in the whole report. */
  readonly weight: number;
  /** Weighted share of known points that passed, 0–100; absent when every point is unknown. */
  readonly score?: number;
  /** `fail` when any rule failed, `unknown` when no rule is known, otherwise `pass`. */
  readonly status: ReadinessStatus;
  /** Known rules that passed. */
  readonly passed: number;
  /** Known rules that failed. */
  readonly failed: number;
  /** Rules left out because a prerequisite is missing. */
  readonly unknown: number;
}

/** The evaluation suite a dimension reads, when one is supplied. */
export interface ReadinessEvaluation {
  /** Suite name, matching the rubric's `evaluation.suite`. */
  readonly suite: string;
  /** Suite version, matching the rubric's `evaluation.version`. */
  readonly version: string;
  /** The build snapshot the results belong to. */
  readonly snapshot: string;
  /** `pass` or `fail` per rule code; a missing rule is unknown. */
  readonly results: Readonly<Record<string, "pass" | "fail">>;
}

/** How an evaluation report was received, kept beside the score it produced. */
export interface ReadinessEvaluationState {
  /** `pass`, `fail`, or `unknown` when no matching report was supplied. */
  readonly status: ReadinessStatus;
  /** Why the state is unknown, or which suite produced it. */
  readonly reason: string;
  /** The suite name, when a report was read. */
  readonly suite?: string;
  /** The suite version, when a report was read. */
  readonly version?: string;
  /** The build snapshot, when a report was read. */
  readonly snapshot?: string;
}

/** The manifest facts a report carries instead of machine paths or page content. */
export interface ReadinessBuild {
  /** The build's one SHA-256, from the manifest. */
  readonly hash: string;
  /** Doc pages in the build. */
  readonly pages: number;
  /** Files in the build. */
  readonly files: number;
}

/** A versioned readiness report: text and JSON are rendered from this one value. */
export interface ReadinessReport {
  /** The report format version. */
  readonly version: 1;
  /** The JSON Schema that describes this report. */
  readonly schema: "https://github.com/velella-sh/mizzen/schema/readiness-report.schema.json";
  /** The rubric this report scored against. */
  readonly rubric: { readonly version: string };
  /** The engine version that wrote the report. */
  readonly engine: string;
  /** The built site the report describes. */
  readonly build: ReadinessBuild;
  /** `pass` when every known rule passed, `fail` when any failed, `unknown` when nothing is known. */
  readonly status: ReadinessStatus;
  /** The weighted score over known dimensions, 0–100; absent when nothing is known. */
  readonly overall?: number;
  /** One entry per dimension, in rubric order. */
  readonly dimensions: readonly ReadinessDimensionScore[];
  /** One entry per rubric rule, in rubric order. */
  readonly rules: readonly ReadinessRuleResult[];
  /** Findings sorted by dimension, rule, scope, and evidence. */
  readonly findings: readonly ReadinessFinding[];
  /** Rules left out of the score, with their reasons. */
  readonly unknowns: readonly ReadinessRuleResult[];
  /** What the evaluation suite said, or why nothing was scored from it. */
  readonly evaluations: ReadinessEvaluationState;
  /** A link to CI evidence for this exact build, when the caller supplied one. */
  readonly evidence?: string;
  /** Set after redaction for a public report. */
  readonly privacy: { readonly public: boolean; readonly redacted: number };
  /** SHA-256 of this report with `digest` left out. */
  readonly digest: string;
}

/** Thresholds a report must meet; a missing dimension threshold only checks the known score. */
export interface ReadinessGateOptions {
  /** Minimum overall score, 0–100. */
  readonly minOverall?: number;
  /** Minimum per dimension, 0–100. */
  readonly min: Readonly<Partial<Record<ReadinessDimension, number>>>;
  /** `fail` turns any unknown rule into a gate failure. Default `pass`, which only checks known points. */
  readonly onUnknown?: "fail" | "pass";
}

/** One threshold the gate checked. */
export interface ReadinessGateCheck {
  /** The overall score or the dimension name. */
  readonly target: "overall" | ReadinessDimension;
  /** The threshold that applied. */
  readonly minimum: number;
  /** The score, absent when the dimension has no known points. */
  readonly score?: number;
  /** Whether the check passed. */
  readonly passed: boolean;
}

/** The gate's decision for one report. */
export interface ReadinessGateResult {
  /** True only when every check passed. */
  readonly passed: boolean;
  /** Every threshold checked, in rubric order with overall first. */
  readonly checks: readonly ReadinessGateCheck[];
  /** Why the gate failed, in stable order. */
  readonly reasons: readonly string[];
}
