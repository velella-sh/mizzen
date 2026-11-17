/**
 * Renders the public claims a record keeps beside one of its fields: `:evidence[<field>]` becomes one link per claim,
 * in list order, with the claim's readable `title` as the link text and its `url` as the target. The links are
 * separated by `, ` and nothing else: the surrounding words stay in the template, and a field with no claim writes
 * nothing.
 *
 * {@link EvidenceClaims} comes from `validate.ts`, which has already dropped a private key or a broken claim, so this
 * renderer publishes `id`, `title`, and `url` and reads no other key. A name the record does not have is
 * `data.unknown-field`, as with `:field`; an absent field with no claim is the normal case and reports nothing.
 */
import type { Diagnostic } from "../../contracts/index.ts";
import { directivePath, directivePos } from "../directive-context.ts";
import type { EvidenceClaim, EvidenceClaims } from "./validate.ts";

/** What one `:evidence[…]` reads: the record it backs, and the template for diagnostics. */
export interface EvidenceScope {
  readonly record: {
    readonly id: string;
    readonly fields: Readonly<Record<string, unknown>>;
  };
  /** The template, relative to the site root. */
  readonly file: string;
}

/** What one `:evidence[…]` became. */
export interface EvidenceResult {
  /** The node that replaces the directive; `undefined` removes it. */
  readonly replacement?: unknown;
  /** The text the Markdown twin carries. */
  readonly twin: string;
  readonly diagnostics: readonly Diagnostic[];
}

/** Escapes text for an HTML text node. */
function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escapes a value for a double-quoted attribute. */
function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** One claim as an HTML link. */
export function claimHtml(claim: EvidenceClaim): string {
  return `<a href="${escapeAttr(claim.url)}">${escapeText(claim.title)}</a>`;
}

/** One claim as a Markdown link, for the page's twin. */
function claimMarkdown(claim: EvidenceClaim): string {
  return `[${claim.title.replace(/([[\]\\])/g, "\\$1")}](${claim.url})`;
}

/** One field's claims as HTML links in list order, or the empty string when it has none. */
export function evidenceLinks(claims: readonly EvidenceClaim[] | undefined): string {
  return (claims ?? []).map(claimHtml).join(", ");
}

/** The literal directive, kept when the field cannot be shown. */
function literal(field: string, node: { readonly position?: unknown }): unknown {
  return { type: "text", value: `:evidence[${field}]`, position: node.position };
}

/** Applies one `:evidence[…]` node to the public claims that back its field. */
export function applyEvidence(
  node: {
    readonly position?: {
      readonly start: { readonly line: number; readonly column: number };
      readonly end: { readonly line: number; readonly column: number };
    } | undefined;
    readonly children?: readonly unknown[] | undefined;
  },
  scope: EvidenceScope,
  claims: EvidenceClaims,
): EvidenceResult {
  const field = directivePath(node.children);
  const pos = directivePos(node.position, scope.file);

  if (field === "" || !Object.hasOwn(scope.record.fields, field)) {
    return {
      replacement: literal(field, node),
      twin: `:evidence[${field}]`,
      diagnostics: [{
        id: "data.unknown-field",
        severity: "error",
        message:
          field === ""
            ? "A `:evidence[…]` directive needs a field name."
            : `The field "${field}" is not one the record "${scope.record.id}" has.`,
        ...(pos === undefined ? {} : { pos }),
        help: "Point the directive at a top-level field of the record.",
      }],
    };
  }

  const backed = Object.hasOwn(claims, field) ? claims[field] : undefined;
  if (backed === undefined || backed.length === 0) return { twin: "", diagnostics: [] };
  return {
    replacement: { type: "html", value: evidenceLinks(backed) },
    twin: backed.map(claimMarkdown).join(", "),
    diagnostics: [],
  };
}
