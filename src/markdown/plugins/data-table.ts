/**
 * `::data-table{from=… columns=…}`: renders records from `_data` or a collection as the same table a Markdown table
 * produces, so the theme's table styles apply with no new markup. `sort` names one field, `where` filters on one
 * `field=value` pair, and `columns` is a comma-separated list of field paths.
 *
 * The model applies {@link applyDataTable} after the page cache. The `plugin` export exists because every file in this
 * folder is discovered as a Markdown plugin; it has no work of its own.
 */
import type { Root } from "mdast";
import type { Plugin } from "unified";
import type { Diagnostic } from "../../contracts/index.ts";
import {
  directivePos,
  resolveDataPath,
  resolveInValue,
  scalarText,
  type DataDirectiveContext,
} from "../../data/directive-context.ts";

export const name = "data-table";
export const order = 61;

/** Discovery reads this file; the table is applied by the model, after the page cache. */
export const plugin: Plugin<[], Root> = () => () => {};

/** What one `::data-table` node became. */
export interface DataTableResult {
  /** The replacement node: a table, or a paragraph holding the literal directive on failure. */
  readonly replacement: unknown;
  /** Markdown for the twin, when the table rendered. */
  readonly twin?: string;
  readonly diagnostics: readonly Diagnostic[];
}

/** The rows a `from` value names, each as a field mapping. */
function rowsOf(from: string, ctx: DataDirectiveContext): readonly Record<string, unknown>[] | undefined {
  const collection = ctx.collections[from];
  if (collection !== undefined) return collection.records.map((record) => record.fields);

  const path = from.startsWith("_data.") ? from.slice("_data.".length) : from;
  const found = resolveDataPath(path, ctx);
  if (!found.found) return undefined;
  if (Array.isArray(found.value)) {
    return found.value.filter(
      (row): row is Record<string, unknown> => typeof row === "object" && row !== null && !Array.isArray(row),
    );
  }
  if (typeof found.value === "object" && found.value !== null) {
    return Object.entries(found.value as Record<string, unknown>)
      .filter(([, row]) => typeof row === "object" && row !== null && !Array.isArray(row))
      .map(([id, row]) => ({ ...(row as Record<string, unknown>), id }));
  }
  return undefined;
}

/** A value's text for a cell; a non-scalar keeps its JSON text, and an absent value is empty. */
function cellText(value: unknown): string {
  const text = scalarText(value);
  if (text !== undefined) return text;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/** A table cell's text as Markdown: a pipe is escaped and a line break becomes `<br>`. */
function markdownCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r\n|\r|\n/g, "<br>");
}

/** A `tableCell` node holding plain text. */
function cell(value: string): unknown {
  return { type: "tableCell", children: value === "" ? [] : [{ type: "text", value }] };
}

/** A `tableRow` node from cell texts. */
function row(values: readonly string[]): unknown {
  return { type: "tableRow", children: values.map(cell) };
}

/** The failure node: a paragraph with the directive's literal name, so the page still renders. */
function literal(position: unknown): unknown {
  return { type: "paragraph", children: [{ type: "text", value: "::data-table" }], position };
}

/** Resolves one `::data-table` node. */
export function applyDataTable(
  node: {
    readonly position?: {
      readonly start: { readonly line: number; readonly column: number };
      readonly end: { readonly line: number; readonly column: number };
    };
    readonly attributes?: Readonly<Record<string, string | null | undefined>>;
  },
  ctx: DataDirectiveContext,
): DataTableResult {
  const pos = directivePos(node.position, ctx.file);
  const attributes = node.attributes ?? {};
  const from = attributes["from"] ?? "";
  const columns = (attributes["columns"] ?? "")
    .split(",")
    .map((column) => column.trim())
    .filter((column) => column !== "");
  const diagnostics: Diagnostic[] = [];

  if (from === "" || columns.length === 0) {
    diagnostics.push({
      id: "data.table-attributes",
      severity: "error",
      message: "A data table needs `from` and `columns`.",
      ...(pos === undefined ? {} : { pos }),
      help: "Write ::data-table{from=components columns=name,status}.",
    });
    return { replacement: literal(node.position), diagnostics };
  }

  const rows = rowsOf(from, ctx);
  if (rows === undefined) {
    diagnostics.push({
      id: "data.table-unknown-source",
      severity: "error",
      message: `A data table names "${from}", which is no collection and holds no records.`,
      ...(pos === undefined ? {} : { pos }),
      help: "Use a collection name or a path to a list in _data.",
    });
    return { replacement: literal(node.position), diagnostics };
  }

  for (const column of columns) {
    if (!rows.some((entry) => resolveInValue(entry, column).found)) {
      diagnostics.push({
        id: "data.table-unknown-column",
        severity: "error",
        message: `A data table names the column "${column}", which no record has.`,
        ...(pos === undefined ? {} : { pos }),
        help: "Use a field the records hold; a nested field is written with dots.",
      });
    }
  }

  let selected = rows.map((entry, index) => ({ entry, index }));
  const where = attributes["where"] ?? "";
  if (where !== "") {
    const equals = where.indexOf("=");
    if (equals < 1) {
      diagnostics.push({
        id: "data.table-where",
        severity: "error",
        message: "`where` must be one `field=value` pair.",
        ...(pos === undefined ? {} : { pos }),
        help: "Write where=status=stable.",
      });
    } else {
      const field = where.slice(0, equals).trim();
      const expected = where.slice(equals + 1).trim();
      selected = selected.filter(({ entry }) => {
        const found = resolveInValue(entry, field);
        return found.found && cellText(found.value) === expected;
      });
    }
  }

  const sort = attributes["sort"] ?? "";
  if (sort !== "") {
    const text = (entry: Record<string, unknown>): string => {
      const found = resolveInValue(entry, sort);
      return found.found ? cellText(found.value) : "";
    };
    selected = [...selected].sort((a, b) => {
      const left = text(a.entry);
      const right = text(b.entry);
      if (left !== right) return left < right ? -1 : 1;
      return a.index - b.index;
    });
  }

  const header = columns.map((column) => markdownCell(column));
  const body = selected.map(({ entry }) =>
    columns.map((column) => {
      const found = resolveInValue(entry, column);
      return markdownCell(found.found ? cellText(found.value) : "");
    }),
  );
  const table = {
    type: "table",
    position: node.position,
    children: [row(columns), ...body.map(row)],
  };
  const twin = [`| ${header.join(" | ")} |`, `| ${columns.map(() => "---").join(" | ")} |`, ...body.map((cells) => `| ${cells.join(" | ")} |`)].join("\n");
  return { replacement: table, twin, diagnostics };
}
