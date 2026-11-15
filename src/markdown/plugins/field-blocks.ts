/**
 * `:::if{field=…}` and `:::each{field=…}`: the two conditional blocks a record page's template may use.
 *
 * `if` keeps its body only when the field has a value (not absent, `null`, an empty string, or an empty list or
 * mapping). `each` repeats its body once per item of a list field, and inside the body the item's own fields come
 * first. There are no expressions, comparisons, or calls: a template is not a program. The page reports a block nested
 * more than one level deep and a field that is not a list.
 */
import type { Diagnostic } from "../../contracts/index.ts";
import { resolveField, type RecordScope } from "../../data/record-context.ts";

export const name = "field-blocks";
export const order = 63;

/** Discovery reads this file; record pages apply the blocks after their template is parsed. */
export const plugin = () => () => {};

/** The part of a directive node the blocks read. */
export interface BlockNode {
  readonly position?: {
    readonly start: { readonly line: number; readonly column: number };
    readonly end: { readonly line: number; readonly column: number };
  };
  readonly attributes?: Readonly<Record<string, string | null | undefined>>;
}

/** The `field` attribute of a block, or `""` when it is missing. */
export function blockField(node: BlockNode): string {
  const value = node.attributes?.["field"];
  return typeof value === "string" ? value.trim() : "";
}

/** A position from the node's template span. */
function posOf(node: BlockNode, file: string): Diagnostic["pos"] | undefined {
  const start = node.position?.start;
  const end = node.position?.end;
  if (start === undefined || end === undefined) return undefined;
  return {
    file,
    line: start.line,
    column: start.column,
    endLine: end.line,
    endColumn: end.line === start.line ? Math.max(start.column, end.column - 1) : Math.max(1, end.column - 1),
  };
}

/** One finding at a block's directive. */
function finding(id: string, message: string, help: string, node: BlockNode, scope: RecordScope) {
  const pos = posOf(node, scope.file);
  return {
    id,
    severity: "error" as const,
    message,
    ...(pos === undefined ? {} : { pos }),
    help,
  };
}

/** The `field` a block names, or the finding that keeps it from running. */
function fieldOf(
  node: BlockNode,
  scope: RecordScope,
  block: "if" | "each",
): { readonly path?: string; readonly diagnostic?: Diagnostic } {
  const path = blockField(node);
  if (path === "") {
    return {
      diagnostic: finding(
        "data.block-field",
        `A \`:::${block}\` block needs a \`field\` attribute.`,
        `Write \`:::${block}{field=<name>}\`.`,
        node,
        scope,
      ),
    };
  }
  return { path };
}

/** Whether an `if` block keeps its body. */
export function ifKeeps(node: BlockNode, scope: RecordScope): { keep: boolean; diagnostics: readonly Diagnostic[] } {
  const named = fieldOf(node, scope, "if");
  if (named.diagnostic !== undefined) return { keep: false, diagnostics: [named.diagnostic] };
  const found = resolveField(scope, named.path!);
  if (!found.found) return { keep: false, diagnostics: [] };
  const value = found.value;
  if (value === null || value === undefined || value === "") return { keep: false, diagnostics: [] };
  if (Array.isArray(value)) return { keep: value.length > 0, diagnostics: [] };
  if (typeof value === "object") return { keep: Object.keys(value).length > 0, diagnostics: [] };
  return { keep: true, diagnostics: [] };
}

/** The items an `each` block repeats over. */
export function eachItems(
  node: BlockNode,
  scope: RecordScope,
): { items: readonly Readonly<Record<string, unknown>>[]; diagnostics: readonly Diagnostic[] } {
  const named = fieldOf(node, scope, "each");
  if (named.diagnostic !== undefined) return { items: [], diagnostics: [named.diagnostic] };
  const found = resolveField(scope, named.path!);
  if (!found.found || found.value === null || found.value === undefined) return { items: [], diagnostics: [] };
  const value = found.value;
  if (!Array.isArray(value)) {
    return {
      items: [],
      diagnostics: [
        finding(
          "data.each-not-list",
          `The field "${named.path}" is not a list, so \`:::each\` cannot repeat the block.`,
          "Point the block at a list field.",
          node,
          scope,
        ),
      ],
    };
  }
  const items: Readonly<Record<string, unknown>>[] = [];
  for (const item of value) {
    items.push(typeof item === "object" && item !== null && !Array.isArray(item) ? (item as Record<string, unknown>) : {});
  }
  return { items, diagnostics: [] };
}
