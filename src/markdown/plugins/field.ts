/**
 * `:field[path]`: shows one field of the record a template page was built from. The text carries the field's position
 * in the data file as `data-src`, so a reader can go from the rendered value to the line to edit. A dotted path reads a
 * nested value. An absent optional field renders nothing, never `undefined` or `null`; a field the schema does not
 * declare, or a value that is not a scalar, is an error at the directive in the template.
 *
 * A field the config marks as Markdown is handed back to the page with {@link FieldResult.markdown}, so the page can
 * replace its block with the parsed field. The `plugin` export exists because every file in this folder is discovered
 * as a Markdown plugin; it has no work of its own.
 */
import type { Root } from "mdast";
import type { Plugin } from "unified";
import type { Diagnostic, RecordPos, SourcePos } from "../../contracts/index.ts";
import { directivePath, directivePos } from "../../data/directive-context.ts";
import {
  declaredField,
  fieldPosition,
  resolveField,
  scalarText,
  topField,
  type RecordScope,
} from "../../data/record-context.ts";

export const name = "field";
export const order = 62;

/** Discovery reads this file; record pages apply the value after their template is parsed. */
export const plugin: Plugin<[], Root> = () => () => {};

/** A Markdown field the page should parse and place as blocks. */
export interface MarkdownField {
  readonly value: string;
  readonly span: RecordPos;
  readonly top: string;
}

/** What one `:field[…]` became. */
export interface FieldResult {
  /** The node that replaces the directive; `undefined` removes it. */
  readonly replacement?: unknown;
  /** Set when the field is Markdown and the page should render it as blocks. */
  readonly markdown?: MarkdownField;
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

/** True for a span a data file really holds. */
function usable(position: SourcePos): boolean {
  return (
    [position.line, position.column, position.endLine, position.endColumn].every(
      (value) => Number.isInteger(value) && value >= 1,
    ) && (position.endLine > position.line || (position.endLine === position.line && position.endColumn >= position.column))
  );
}

/** The rendered value: a span naming the field's line in the data file. */
export function fieldHtml(text: string, position: SourcePos): unknown {
  const attributes = usable(position)
    ? ` data-src="${escapeAttr(`${position.file}:${position.line}:${position.column}-${position.endLine}:${position.endColumn}`)}"`
    : "";
  return { type: "html", value: `<span${attributes}>${escapeText(text)}</span>` };
}

/** The literal directive, kept when the value cannot be shown. */
function literal(path: string, node: { readonly position?: unknown }): unknown {
  return { type: "text", value: `:field[${path}]`, position: node.position };
}

/** Applies one `:field[…]` node. */
export function applyField(
  node: {
    readonly position?: {
      readonly start: { readonly line: number; readonly column: number };
      readonly end: { readonly line: number; readonly column: number };
    } | undefined;
    readonly children?: readonly unknown[] | undefined;
  },
  scope: RecordScope,
): FieldResult {
  const path = directivePath(node.children);
  const pos = directivePos(node.position, scope.file);

  if (path === "") {
    return {
      replacement: literal(path, node),
      twin: ":field[]",
      diagnostics: [{
        id: "data.field-path",
        severity: "error",
        message: "A `:field[…]` directive needs a field name.",
        ...(pos === undefined ? {} : { pos }),
        help: "Write the field name inside the brackets, such as `:field[title]`.",
      }],
    };
  }

  const found = resolveField(scope, path);
  if (!found.found) {
    if (!declaredField(scope, path)) {
      return {
        replacement: literal(path, node),
        twin: `:field[${path}]`,
        diagnostics: [{
          id: "data.unknown-field",
          severity: "error",
          message: `The field "${path}" is not one the collection "${scope.collection}" declares.`,
          ...(pos === undefined ? {} : { pos }),
          help: "Use a field the collection's schema declares, or add it to the schema and the data.",
        }],
      };
    }
    // An optional field that is absent renders nothing.
    return { twin: "", diagnostics: [] };
  }

  const value = found.value;
  if (value === undefined || value === null) return { twin: "", diagnostics: [] };

  const top = topField(path);
  const position = fieldPosition(scope, path);
  if (scope.markdownFields.has(top) && typeof value === "string") {
    const span: RecordPos = {
      file: position.file,
      startLine: position.line,
      startColumn: position.column,
      endLine: position.endLine,
      endColumn: position.endColumn,
    };
    return {
      replacement: fieldHtml(value, position),
      markdown: { value, span, top },
      twin: value,
      diagnostics: [],
    };
  }

  const text = scalarText(value);
  if (text === undefined) {
    return {
      replacement: literal(path, node),
      twin: `:field[${path}]`,
      diagnostics: [{
        id: "data.not-a-scalar",
        severity: "error",
        message: `The field "${path}" is not a value a page can show as text.`,
        ...(pos === undefined ? {} : { pos }),
        help: "Point the directive at a string, number, or boolean, or mark the field as Markdown.",
      }],
    };
  }
  return {
    replacement: fieldHtml(text, position),
    twin: text,
    diagnostics: [],
  };
}
