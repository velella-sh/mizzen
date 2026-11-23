/**
 * The public form of a knowledge declaration. The status, its scope, and its review state are always published: a
 * reader must be able to see that something is unknown. The rationale and the citation value are private by default —
 * an author who wants them published says so — and a private value is replaced with a fixed placeholder, never
 * shortened, hashed, or quoted, so no part of it reaches any public output.
 */
import type {
  KnowledgeCitation,
  KnowledgeDeclaration,
  KnowledgePublicDeclaration,
  KnowledgeReview,
  KnowledgeScope,
  KnowledgeStatus,
} from "../contracts/knowledge.ts";
import type { SourcePos } from "../contracts/source.ts";
import { formatSpan } from "../source/spans.ts";

/** The placeholder a private rationale is replaced with. It names nothing about the value. */
export const REDACTED_RATIONALE = "[rationale withheld]";

/** The placeholder a private citation is replaced with. */
export const REDACTED_CITATION = "[citation withheld]";

/** The public form of one declaration: the status, scope, review, and only what the author allowed. */
export function publicDeclarationOf(
  declaration: KnowledgeDeclaration,
  review: KnowledgeReview,
): KnowledgePublicDeclaration {
  const citation = publicCitation(declaration.citation);
  const rationale = declaration.rationale === undefined
    ? undefined
    : declaration.public === true
      ? declaration.rationale
      : REDACTED_RATIONALE;
  return {
    status: declaration.status,
    scope: declaration.scope.map((item) => ({ kind: item.kind, value: item.value })),
    ...(rationale === undefined ? {} : { rationale }),
    ...(citation === undefined ? {} : { citation }),
    review: { required: review.required, reasons: review.reasons },
    span: formatSpan(declaration.span),
    ...(declaration.expires === undefined ? {} : { expires: declaration.expires }),
    redacted: declaration.public !== true && (declaration.rationale !== undefined || privateCitation(declaration.citation)),
  };
}

/** The published citation, or `undefined` when there is none or it is private. */
function publicCitation(citation: KnowledgeCitation | undefined): string | undefined {
  if (citation === undefined) return undefined;
  return citation.public === true ? citation.value : REDACTED_CITATION;
}

/** True when a citation exists but is kept private. */
function privateCitation(citation: KnowledgeCitation | undefined): boolean {
  return citation !== undefined && citation.public !== true;
}

/** One scope limit as public output shows it. */
function publicScope(scope: KnowledgeScope): KnowledgeScope {
  return { kind: scope.kind, value: scope.value };
}

/** The span of a declaration as public output carries it: forward slashes, relative to the repository root. */
export function publicSpan(span: SourcePos): string {
  return formatSpan(span);
}
