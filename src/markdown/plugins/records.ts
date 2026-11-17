/**
 * `:::records{from=… where=… sort=… limit=…}`: repeats its body for records of one other collection.
 *
 * `from` names exactly one collection. `where` is one pair, `field=other`: the left side is read from the candidate
 * record, and the right side is read from the current record when it names a field there, otherwise it is a literal, so
 * `where="parent=id"` lists a record's children. `sort` names one field and falls back to the id and then to source
 * order; `limit` keeps the first N. Records keep source order when no sort is named.
 */
import type { DataRecord, Diagnostic } from "../../contracts/index.ts";
import { fieldsWithDerived } from "../../data/derived.ts";
import { resolveField, resolveIn, scalarText, type RecordScope } from "../../data/record-context.ts";

export const name = "records";
export const order = 64;

/** Discovery reads this file; record pages apply the directive after their template is parsed. */
export const plugin = () => () => {};

/** What one `:::records` block selected. */
export interface RecordsSelection {
  readonly records: readonly DataRecord[];
  readonly diagnostics: readonly Diagnostic[];
}

/** A directive node's template span, as a diagnostic position. */
function posOf(node: { readonly position?: { readonly start: { readonly line: number; readonly column: number }; readonly end: { readonly line: number; readonly column: number } } }, file: string): Diagnostic["pos"] | undefined {
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

/** Compares two values as text, then by code point. */
function byValue(a: unknown, b: unknown): number {
  const left = scalarText(a) ?? "";
  const right = scalarText(b) ?? "";
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** True when every candidate value in `where` matches, comparing scalars as text. */
function matches(
  candidate: Readonly<Record<string, unknown>>,
  where: string,
  scope: RecordScope,
): boolean {
  const at = where.indexOf("=");
  if (at < 0) return false;
  const left = where.slice(0, at).trim();
  const right = where.slice(at + 1).trim();
  if (left === "" || right === "") return false;
  const found = resolveIn(candidate, left);
  if (!found.found) return false;
  const expected = resolveField(scope, right);
  const wanted = expected.found ? scalarText(expected.value) : right.replace(/^["']|["']$/g, "");
  if (wanted === undefined) return false;
  return scalarText(found.value) === wanted;
}

/**
 * Selects the records one `:::records` block repeats over. A missing or unknown `from`, a malformed `where`, and a
 * `limit` that is not a positive whole number are errors at the block; the block then renders nothing.
 */
export function selectRecords(
  node: {
    readonly position?: {
      readonly start: { readonly line: number; readonly column: number };
      readonly end: { readonly line: number; readonly column: number };
    };
    readonly attributes?: Readonly<Record<string, string | null | undefined>>;
  },
  scope: RecordScope,
): RecordsSelection {
  const at = (id: string, message: string, help: string): Diagnostic => {
    const pos = posOf(node, scope.file);
    return {
      id,
      severity: "error",
      message,
      ...(pos === undefined ? {} : { pos }),
      help,
    };
  };
  const attributes = node.attributes ?? {};
  const from = attributes["from"]?.trim() ?? "";
  if (from === "") {
    return {
      records: [],
      diagnostics: [at("data.records-from", "A `:::records` block needs a `from` collection.", "Write `:::records{from=<collection>}`.")],
    };
  }
  const collection = scope.collections[from];
  if (collection === undefined) {
    return {
      records: [],
      diagnostics: [
        at(
          "data.unknown-collection",
          `The \`:::records\` block names the collection "${from}", which the site does not have.`,
          "Name a collection the config declares.",
        ),
      ],
    };
  }

  let selected = [...collection.records];
  const where = attributes["where"]?.trim() ?? "";
  if (where !== "") {
    const separator = where.indexOf("=");
    if (separator <= 0 || separator === where.length - 1) {
      return {
        records: [],
        diagnostics: [
          at(
            "data.records-where",
            `The \`where\` of a \`:::records\` block is one pair, \`field=field\`.`,
            "Write `where=\"parent=id\"`, or remove `where`.",
          ),
        ],
      };
    }
    selected = selected.filter((record) => matches(fieldsWithDerived(record), where, scope));
  }

  const sort = attributes["sort"]?.trim() ?? "";
  if (sort !== "") {
    selected = selected
      .map((record, index) => ({ record, index, id: String(record.fields["id"] ?? "") }))
      .sort(
        (a, b) =>
          byValue(resolveIn(fieldsWithDerived(a.record), sort).value, resolveIn(fieldsWithDerived(b.record), sort).value) ||
          byCodePoint(a.id, b.id) ||
          a.index - b.index,
      )
      .map((entry) => entry.record);
  }

  const rawLimit = attributes["limit"]?.trim() ?? "";
  if (rawLimit !== "") {
    if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1) {
      return {
        records: [],
        diagnostics: [
          at(
            "data.records-limit",
            `The \`limit\` of a \`:::records\` block is a whole number of at least 1.`,
            "Write `limit=3`, or remove `limit`.",
          ),
        ],
      };
    }
    selected = selected.slice(0, Number(rawLimit));
  }

  return { records: selected, diagnostics: [] };
}
