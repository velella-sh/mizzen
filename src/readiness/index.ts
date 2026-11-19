/** The readiness surface: rubric, scan, findings, score, versioned report, and gate. */
export {
  RUBRIC,
  byCodePoint,
  dimensionOf,
  ruleOf,
  rulesOf,
  type ReadinessRubric,
  type RubricDimension,
  type RubricRule,
} from "./rubric.ts";
export { pageScope, namedScope, siteScope, finding, compareFindings, type FindingInput } from "./findings.ts";
export { scanBuild, rubricRules, dimensionOfCode, scanHasBuild, type RuleOutcome, type ScanOptions, type ScanResult } from "./scan.ts";
export { scoreOf, type ReadinessScore } from "./score.ts";
export {
  REPORT_SCHEMA,
  formatReadiness,
  formatReadinessJson,
  readinessDigest,
  readinessReport,
  verifyReadinessReport,
  type ReportOptions,
} from "./report.ts";
export { gateReadiness } from "./gate.ts";
export { compareReadiness, checkedReport, formatComparison, ReadinessCompareError, type PageChange, type ReadinessComparison, type RuleChange } from "./compare.ts";
export { badgeMarkdown, badgeSvg, badgeTitle, badgeValue, ReadinessBadgeError } from "./badge.ts";
export { redactReadinessReport, type RedactOptions } from "./redact.ts";
export { parseEvaluationReport, readEvaluationReport, type EvaluationRead, type EvaluationReport } from "./evals.ts";
