/**
 * `:data[path]`: shows one `_data` value or one collection record field as text.
 *
 * The model applies {@link applyDataValue} after the page cache, so the parsed tree stays reusable and the resolved
 * value is never cached. The `plugin` export exists because every file in this folder is discovered as a Markdown
 * plugin; it has no work of its own.
 */
import type { Root } from "mdast";
import type { Plugin } from "unified";
import type { Diagnostic } from "../../contracts/index.ts";
import {
  directivePath,
  directivePos,
  resolveDataPath,
  scalarText,
  unknownPathDiagnostic,
  type DataDirectiveContext,
} from "../../data/directive-context.ts";

export const name = "data-value";
export const order = 60;

/** Discovery reads this file; the value is applied by the model, after the page cache. */
export const plugin: Plugin<[], Root> = () => () => {};

/** A directive the model found, with the node that replaces it and the text the Markdown twin carries. */
export interface DataValueResult {
  /** The replacement node; a text node with the value, or the literal directive on failure. */
  readonly replacement: unknown;
  /** Text for the Markdown twin, when the value resolved. */
  readonly twin?: string;
  readonly diagnostics: readonly Diagnostic[];
}

/** Resolves one `:data[…]` node. */
export function applyDataValue(
  node: {
    readonly position?: {
      readonly start: { readonly line: number; readonly column: number };
      readonly end: { readonly line: number; readonly column: number };
    };
    readonly children?: readonly unknown[];
  },
  ctx: DataDirectiveContext,
): DataValueResult {
  const path = directivePath(node.children);
  const pos = directivePos(node.position, ctx.file);
  const found = resolveDataPath(path, ctx);
  if (!found.found) {
    return {
      replacement: { type: "text", value: `:data[${path}]`, position: node.position },
      diagnostics: [unknownPathDiagnostic(path, pos)],
    };
  }
  const text = scalarText(found.value);
  if (text === undefined) {
    return {
      replacement: { type: "text", value: `:data[${path}]`, position: node.position },
      diagnostics: [{
        id: "data.not-a-scalar",
        severity: "error",
        message: `"${path}" is not a scalar a page can show as text.`,
        ...(pos === undefined ? {} : { pos }),
        help: "Point the directive at a string, number, or boolean.",
      }],
    };
  }
  return {
    replacement: { type: "text", value: text, position: node.position },
    twin: text,
    diagnostics: [],
  };
}
