import type { SourcePos } from "../contracts/source.ts";
import type { ReadinessFinding, ReadinessScope, ReadinessSeverity } from "../contracts/readiness.ts";
import { ruleOf, type RubricRule } from "./rubric.ts";

/** A finding about the whole site. */
export function siteScope(): ReadinessScope {
  return { kind: "site", systemic: true };
}

/** A finding about one page; `block` names a stable block when there is one. */
export function pageScope(page: string, block?: string): ReadinessScope {
  return block === undefined
    ? { kind: "page", page, systemic: false }
    : { kind: "block", page, block, systemic: false };
}

/** A finding about one collection or symbol, when a future rule can name one. */
export function namedScope(kind: "collection" | "symbol", name: string): ReadinessScope {
  return kind === "collection"
    ? { kind, collection: name, systemic: false }
    : { kind, symbol: name, systemic: false };
}

/** Options of {@link finding}. */
export interface FindingInput {
  /** Where the finding sits. */
  readonly scope: ReadinessScope;
  /** What is wrong, in one sentence. */
  readonly message: string;
  /** What was observed, without page text or machine paths. */
  readonly evidence: string;
  /** The source span, when one is known. */
  readonly pos?: SourcePos;
  /** Defaults to `error`, because a failed rule is a gate failure. */
  readonly severity?: ReadinessSeverity;
}

/** One finding for a rule, with the rule's remediation attached. */
export function finding(rule: RubricRule | string, input: FindingInput): ReadinessFinding {
  const scored = typeof rule === "string" ? ruleOf(rule) : rule;
  return {
    code: scored.code,
    dimension: scored.dimension,
    severity: input.severity ?? "error",
    scope: input.scope,
    ...(input.pos === undefined ? {} : { pos: input.pos }),
    evidence: input.evidence,
    message: input.message,
    remediation: { action: scored.action, link: scored.link },
  };
}

/** Sorts findings by rule, scope, evidence, and message, so two scans of one build agree. */
export function compareFindings(a: ReadinessFinding, b: ReadinessFinding): number {
  const byCode = a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
  if (byCode !== 0) return byCode;
  const byKind = a.scope.kind < b.scope.kind ? -1 : a.scope.kind > b.scope.kind ? 1 : 0;
  if (byKind !== 0) return byKind;
  const byPage = (a.scope.page ?? "") < (b.scope.page ?? "") ? -1 : (a.scope.page ?? "") > (b.scope.page ?? "") ? 1 : 0;
  if (byPage !== 0) return byPage;
  const byBlock = (a.scope.block ?? "") < (b.scope.block ?? "") ? -1 : (a.scope.block ?? "") > (b.scope.block ?? "") ? 1 : 0;
  if (byBlock !== 0) return byBlock;
  const byEvidence = a.evidence < b.evidence ? -1 : a.evidence > b.evidence ? 1 : 0;
  if (byEvidence !== 0) return byEvidence;
  return a.message < b.message ? -1 : a.message > b.message ? 1 : 0;
}
