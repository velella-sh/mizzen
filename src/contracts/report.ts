/** Display severity supplied by the producer. The original severity may also be retained. */
export type ReportSeverity = "error" | "warning" | "info" | "unknown";

/** Public finding data. An id identifies the same finding across comparable runs. */
export interface ReportFinding {
  readonly id: string;
  readonly rule?: string;
  readonly message: string;
  readonly severity: ReportSeverity;
  readonly originalSeverity?: string;
  readonly location?: { readonly path: string; readonly line?: number; readonly column?: number };
  readonly evidence?: readonly string[];
}

/** A named check outcome, independent of a finding's severity. */
export interface ReportCheck {
  readonly id: string;
  readonly status: "passed" | "failed" | "skipped" | "unknown";
  readonly detail?: string;
}

/** A numeric measurement in an explicit unit. */
export interface ReportMetric {
  readonly id: string;
  readonly unit: string;
  readonly value: number;
  readonly limit?: number;
}

/** One published run. Scope identifies inputs and settings that permit comparing runs. */
export interface ReportRun {
  readonly id: string;
  readonly tool: string;
  readonly toolVersion?: string;
  readonly scope: string;
  readonly revision?: string;
  readonly date?: string;
  readonly coverage: "complete" | "partial" | "unavailable";
  readonly checks: readonly ReportCheck[];
  readonly findings: readonly ReportFinding[];
  readonly metrics: readonly ReportMetric[];
  readonly evidence?: readonly string[];
}

/** Versioned public input loaded from `_data/report-set.json`. */
export interface ReportSet {
  readonly schemaVersion: 1;
  readonly title: string;
  readonly route: string;
  readonly runs: readonly ReportRun[];
  readonly comparisons: readonly { readonly base: string; readonly head: string }[];
}

/** A finding's change and its values on the sides that recorded it. */
export interface ReportChange {
  readonly kind: "new" | "resolved" | "changed" | "unchanged";
  readonly before?: ReportFinding;
  readonly after?: ReportFinding;
}

/** Result of comparing a configured pair in the order supplied by the author. */
export interface ReportComparison {
  readonly base: string;
  readonly head: string;
  readonly state: "comparable" | "different-scope" | "incomplete";
  readonly changes: readonly ReportChange[];
}

/** One series is scoped to a single producer, scope, measurement and unit. */
export interface ReportSeries {
  readonly tool: string;
  readonly scope: string;
  readonly kind: "findings" | "metric";
  readonly id: string;
  readonly unit: string;
  readonly points: readonly { readonly run: string; readonly date: string | null; readonly value: number | null }[];
}

/** Public build output shared by the theme and machine consumers. */
export interface PreparedReport {
  readonly schemaVersion: 1;
  readonly title: string;
  readonly url: string;
  readonly jsonUrl: string;
  readonly runs: readonly (ReportRun & { readonly url: string })[];
  readonly comparisons: readonly (ReportComparison & { readonly url: string })[];
  readonly series: readonly ReportSeries[];
}

/** Bounds and fixed previous/next links for a generated report table. */
export interface ReportPagination {
  readonly start: number;
  readonly end: number;
  readonly page: number;
  readonly pages: number;
  readonly previous?: string;
  readonly next?: string;
}

/** Which view and bounded page of its table a generated document carries. */
export type ReportView =
  | { readonly kind: "overview" }
  | ({ readonly kind: "run"; readonly id: string } & ReportPagination)
  | ({ readonly kind: "comparison"; readonly base: string; readonly head: string } & ReportPagination);
