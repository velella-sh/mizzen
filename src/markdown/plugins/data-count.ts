/**
 * `:count{from=… where=…}`: shows how many records of a collection match a filter, in a sentence on an ordinary page.
 *
 * `from` names exactly one collection; `where` is one `field=value` pair and is matched by the same `equals` test a
 * list uses ({@link matchesCondition}), so a list field such as `tags: [news]` counts for `where="tags=news"`. The model
 * applies {@link applyDataCount} after the page cache, and writes the number into the page's Markdown twin, so a data
 * change rebuilds the page with the count it now shows.
 */
import type { Root } from "mdast";
import type { Plugin } from "unified";
import type { Diagnostic } from "../../contracts/index.ts";
import { matchesCondition, type Condition, type Row } from "../../data/query.ts";
import { directivePos, type DataDirectiveContext } from "../../data/directive-context.ts";

export const name = "count";
export const order = 62;

/** Discovery reads this file; the count is applied by the model, after the page cache. */
export const plugin: Plugin<[], Root> = () => () => {};

/** What one `:count` node became. */
export interface DataCountResult {
  readonly replacement: unknown;
  readonly twin?: string;
  readonly diagnostics: readonly Diagnostic[];
}

/** Resolves one `:count{from=… where=…}` node. */
export function applyDataCount(
  node: {
    readonly position?: {
      readonly start: { readonly line: number; readonly column: number };
      readonly end: { readonly line: number; readonly column: number };
    };
    readonly attributes?: Readonly<Record<string, string | null | undefined>>;
  },
  ctx: DataDirectiveContext,
): DataCountResult {
  const pos = directivePos(node.position, ctx.file);
  const attributes = node.attributes ?? {};
  const from = (attributes["from"] ?? "").trim();
  const literal = { type: "text", value: `:count{from=${from}}`, position: node.position };

  if (from === "") {
    return {
      replacement: literal,
      diagnostics: [{
        id: "data.count-attributes",
        severity: "error",
        message: "A count needs a `from` collection.",
        ...(pos === undefined ? {} : { pos }),
        help: "Write :count{from=components}.",
      }],
    };
  }
  const collection = ctx.collections[from];
  if (collection === undefined) {
    return {
      replacement: literal,
      diagnostics: [{
        id: "data.unknown-collection",
        severity: "error",
        message: `The count names the collection "${from}", which the site does not have.`,
        ...(pos === undefined ? {} : { pos }),
        help: "Name a collection the config declares.",
      }],
    };
  }

  const rows: Row[] = collection.records.map((record) => ({
    id: record.id,
    fields: record.fields,
    ...(record.normalizedDates === undefined ? {} : { dates: record.normalizedDates }),
  }));
  let selected = rows;
  const where = (attributes["where"] ?? "").trim();
  if (where !== "") {
    const separator = where.indexOf("=");
    if (separator < 1) {
      return {
        replacement: literal,
        diagnostics: [{
          id: "data.count-where",
          severity: "error",
          message: "The `where` of a count is one `field=value` pair.",
          ...(pos === undefined ? {} : { pos }),
          help: 'Write where="status=stable", or remove `where`.',
        }],
      };
    }
    const field = where.slice(0, separator).trim();
    const expected = where.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    const condition: Condition = { field, kind: "equals", text: expected };
    selected = rows.filter((row) => matchesCondition(row, condition));
  }

  const count = String(selected.length);
  return { replacement: { type: "text", value: count, position: node.position }, twin: count, diagnostics: [] };
}
