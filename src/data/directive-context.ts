/**
 * Shared pieces for the `:data[path]` and `::data-table{…}` directives: how a path is resolved against `_data` and the
 * collections, how a scalar becomes text, and how a directive's own span becomes a diagnostic position.
 *
 * A path is dot-separated. It is looked up in `_data` first, where a numeric segment indexes a list. When that finds
 * nothing, the first segment may name a collection and the second a record id, so `components.button.name` reads the
 * field of one record.
 */
import type { Collection, Diagnostic, SourcePos } from "../contracts/index.ts";

/** What a data directive reads. */
export interface DataDirectiveContext {
  /** The site's `_data` tree, unchanged. */
  readonly data: Readonly<Record<string, unknown>>;
  /** Collections keyed by name. */
  readonly collections: Readonly<Record<string, Collection>>;
  /** The page's source path, for diagnostics. */
  readonly file: string;
}

/** One replacement in the page's Markdown twin: the node's span in the file, and the text that replaces it. */
export interface DirectiveEdit {
  /** Offset of the directive's first character in the expanded page body. */
  readonly start: number;
  /** Offset one past the directive's last character in the expanded page body. */
  readonly end: number;
  readonly text: string;
}

/** A dot-separated path. */
export function pathSegments(path: string): readonly string[] {
  return path
    .trim()
    .split(".")
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "");
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads one path segment from a value, with own keys only and numeric list indexes. */
function step(value: unknown, segment: string): { readonly found: boolean; readonly value?: unknown } {
  if (Array.isArray(value)) {
    const index = /^\d+$/.test(segment) ? Number(segment) : -1;
    return index >= 0 && index < value.length ? { found: true, value: value[index] } : { found: false };
  }
  if (!isMapping(value)) return { found: false };
  if (!Object.prototype.hasOwnProperty.call(value, segment)) return { found: false };
  return { found: true, value: value[segment] };
}

/** Resolves a dot-separated path inside one value, with own keys only and numeric list indexes. */
export function resolveInValue(value: unknown, path: string): { readonly found: boolean; readonly value?: unknown } {
  let current: unknown = value;
  for (const segment of pathSegments(path)) {
    const next = step(current, segment);
    if (!next.found) return { found: false };
    current = next.value;
  }
  return { found: true, value: current };
}

/** Resolves a path against `_data`, then against a collection record. */
export function resolveDataPath(
  path: string,
  ctx: DataDirectiveContext,
): { readonly found: boolean; readonly value?: unknown } {
  const segments = pathSegments(path);
  if (segments.length === 0) return { found: false };

  let current: unknown = ctx.data;
  let found = true;
  for (const segment of segments) {
    const next = step(current, segment);
    if (!next.found) {
      found = false;
      break;
    }
    current = next.value;
  }
  if (found) return { found: true, value: current };

  const [collectionName, id, ...rest] = segments;
  const collection = collectionName === undefined ? undefined : ctx.collections[collectionName];
  const record = collection?.records.find((entry) => entry.id === id);
  if (record === undefined || rest.length === 0) return { found: false };
  let value: unknown = record.fields;
  for (const segment of rest) {
    const next = step(value, segment);
    if (!next.found) return { found: false };
    value = next.value;
  }
  return { found: true, value };
}

/** The text of a scalar; `undefined` for a value an inline directive cannot show. */
export function scalarText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return undefined;
}

/** The diagnostic span of a directive node, or `undefined` when the parser gave it none. */
export function directivePos(
  position: { readonly start: { readonly line: number; readonly column: number }; readonly end: { readonly line: number; readonly column: number } } | undefined,
  file: string,
): SourcePos | undefined {
  if (position === undefined) return undefined;
  const { line, column } = position.start;
  const endLine = position.end.line;
  const endColumn = endLine === line ? Math.max(column, position.end.column - 1) : Math.max(1, position.end.column - 1);
  return { file, line, column, endLine, endColumn };
}

/** A directive's path text, from its parsed children. */
export function directivePath(children: readonly unknown[] | undefined): string {
  let text = "";
  for (const child of children ?? []) {
    const node = child as { readonly type?: string; readonly value?: unknown };
    if (node.type === "text" && typeof node.value === "string") text += node.value;
  }
  return text.trim();
}

/** One diagnostic for a directive whose path names nothing. */
export function unknownPathDiagnostic(path: string, pos: SourcePos | undefined): Diagnostic {
  return {
    id: "data.unknown-path",
    severity: "error",
    message: `No data value matches "${path}".`,
    ...(pos === undefined ? {} : { pos }),
    help: "Name a key under _data or `<collection>.<record>.<field>`.",
  };
}
