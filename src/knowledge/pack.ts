/**
 * The public knowledge of one page as a context pack publishes it, and the Markdown line that matches the JSON.
 * Both the request-driven compiler and the build's `context-pack` output read this one helper, so the two twins can
 * never disagree about a status, a scope, or a citation.
 */
import type { Page } from "../contracts/content.ts";
import type { KnowledgeScope } from "../contracts/knowledge.ts";
import type { PackKnowledge } from "../outputs/context-pack.ts";
import { formatSpan } from "../source/spans.ts";
import { hashOf } from "../outputs/build-hash.ts";
import { reviewOf } from "./parse.ts";

/** The public knowledge of one page, or `undefined` when it declares none. */
export function packKnowledgeOf(page: Page, asOf: string | undefined): PackKnowledge | undefined {
  const declaration = page.knowledge;
  if (declaration === undefined) return undefined;
  const review = reviewOf(declaration, {
    ...(asOf === undefined ? {} : { asOf }),
    evidence: hashOf(page.markdown),
  });
  const citations =
    declaration.citation !== undefined && declaration.citation.public === true
      ? [declaration.citation.value]
      : undefined;
  return {
    status: declaration.status,
    scope: declaration.scope.map((limit) => ({ kind: limit.kind, value: limit.value })),
    ...(citations === undefined ? {} : { citations }),
    review: review.required,
    span: formatSpan(declaration.span),
  };
}

/** A scope as public text, such as `platform:windows, version:v2`. */
export function scopeText(scope: readonly KnowledgeScope[]): string {
  return scope.map((limit) => `${limit.kind}:${limit.value}`).join(", ");
}

/**
 * The Markdown line a pack shows for an item's knowledge, matching the JSON. A page with no declaration adds nothing;
 * a declared status names its scope, its review state, and its public citations, never a private one.
 */
export function knowledgeLine(knowledge: PackKnowledge | undefined): string {
  if (knowledge === undefined) return "";
  const parts = [`- Knowledge: ${knowledge.status}`];
  if (knowledge.scope.length > 0) parts.push(`scope ${scopeText(knowledge.scope)}`);
  if (knowledge.review) parts.push("needs review");
  if (knowledge.citations !== undefined && knowledge.citations.length > 0) {
    parts.push(`cites ${knowledge.citations.join(", ")}`);
  }
  return `\n${parts.join("; ")}`;
}
