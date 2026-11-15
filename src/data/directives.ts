/**
 * Applies the data directives to one parsed page: `:data[path]` becomes the value's text, and
 * `::data-table{…}` becomes a table node. The same replacements are written into the page's Markdown twin, so the
 * HTML and the twin carry the same text.
 *
 * This runs after the page cache, never inside it: a cached tree holds the directives as parsed, and the values are
 * resolved for every build from the current `_data` and collections.
 */
import type { Root, RootContent } from "mdast";
import type { Diagnostic } from "../contracts/index.ts";
import { applyDataCount } from "../markdown/plugins/data-count.ts";
import { applyDataTable } from "../markdown/plugins/data-table.ts";
import { applyDataValue } from "../markdown/plugins/data-value.ts";
import type { DataDirectiveContext, DirectiveEdit } from "./directive-context.ts";

/** The directives a model run found, and the Markdown twin with them resolved. */
export interface DataDirectiveResult {
  /** The page body with each directive that resolved replaced by its text or table. */
  readonly markdown: string;
  readonly diagnostics: readonly Diagnostic[];
}

/** The part of a directive node this module reads. */
interface DirectiveNode {
  readonly type: string;
  readonly name?: string;
  readonly attributes?: Readonly<Record<string, string | null | undefined>>;
  readonly children?: readonly unknown[];
  readonly position?: {
    readonly start: { readonly line: number; readonly column: number; readonly offset?: number };
    readonly end: { readonly line: number; readonly column: number; readonly offset?: number };
  };
}

/** The offsets of a node in the parsed body, or `undefined` when the parser gave none. */
function offsetsOf(node: DirectiveNode): { readonly start: number; readonly end: number } | undefined {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return typeof start === "number" && typeof end === "number" ? { start, end } : undefined;
}

/** Adds one replacement, when the node has a span in the body. */
function addEdit(edits: DirectiveEdit[], node: DirectiveNode, text: string): void {
  const offsets = offsetsOf(node);
  if (offsets !== undefined) edits.push({ start: offsets.start, end: offsets.end, text });
}

/** Rewrites a parent's children, descending into every child that has children. */
function transform(
  parent: { children: readonly unknown[] },
  ctx: DataDirectiveContext,
  edits: DirectiveEdit[],
  diagnostics: Diagnostic[],
): void {
  const children = parent.children as unknown[];
  for (let index = 0; index < children.length; index++) {
    const child = children[index] as DirectiveNode;
    if (child.type === "textDirective" && child.name === "data") {
      const result = applyDataValue(child, ctx);
      diagnostics.push(...result.diagnostics);
      if (result.twin !== undefined) addEdit(edits, child, result.twin);
      children[index] = result.replacement as RootContent;
      continue;
    }
    if (child.type === "textDirective" && child.name === "count") {
      const result = applyDataCount(child, ctx);
      diagnostics.push(...result.diagnostics);
      if (result.twin !== undefined) addEdit(edits, child, result.twin);
      children[index] = result.replacement as RootContent;
      continue;
    }
    if (child.type === "leafDirective" && child.name === "data-table") {
      const result = applyDataTable(child, ctx);
      diagnostics.push(...result.diagnostics);
      if (result.twin !== undefined) addEdit(edits, child, result.twin);
      children[index] = result.replacement as RootContent;
      continue;
    }
    if (Array.isArray(child.children)) transform(child as { children: readonly unknown[] }, ctx, edits, diagnostics);
  }
}

/** Applies every data directive in `tree`; `body` is the expanded Markdown the tree was parsed from. */
export function applyDataDirectives(
  tree: Root,
  body: string,
  ctx: DataDirectiveContext,
): DataDirectiveResult {
  const edits: DirectiveEdit[] = [];
  const diagnostics: Diagnostic[] = [];
  transform(tree, ctx, edits, diagnostics);

  let markdown = body;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    markdown = `${markdown.slice(0, edit.start)}${edit.text}${markdown.slice(edit.end)}`;
  }
  return { markdown, diagnostics };
}
