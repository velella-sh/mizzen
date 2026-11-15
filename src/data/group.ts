/**
 * The grouping half of a list page: one group per value of a field, or per year or month of a date field.
 *
 * A record with a list value joins every group the list names, a record without a value is kept in one named group
 * rather than dropped, and groups are ordered by key by default or by size (largest first, then key), so the order never
 * depends on the source. A date group reads the record's normalized date, so `January` is the same group however the
 * date was written in the source.
 */
import type { Diagnostic, SourcePos } from "../contracts/index.ts";
import { resolveIn, scalarText } from "./record-context.ts";
import { compareCodePoint, type Row } from "./query.ts";

/** How a list groups its records. */
export interface GroupSpec {
  readonly field: string;
  /** Group by the value as written, or by the year or the month of a date field. */
  readonly by: "value" | "year" | "month";
  /** Order groups by key (the default) or by size. */
  readonly order: "key" | "size";
  /** The key of the group that holds records without a value. Default `(missing)`. */
  readonly missing: string;
}

/** One group of rows. */
export interface Grouping<T> {
  readonly key: string;
  readonly rows: readonly T[];
}

/** The default reading of a `group` value: the field alone. */
export const DEFAULT_GROUP: Omit<GroupSpec, "field"> = { by: "value", order: "key", missing: "(missing)" };

/** Reads `group: <field>` or `group: { field, by, order, missing }`; a bad shape is one finding and no grouping. */
export function parseGroup(raw: unknown, pos: SourcePos | undefined): { readonly spec?: GroupSpec; readonly diagnostics: readonly Diagnostic[] } {
  if (raw === undefined) return { diagnostics: [] };
  const fail = (message: string): { readonly diagnostics: readonly Diagnostic[] } => ({
    diagnostics: [{
      id: "data.list-group",
      severity: "error",
      message,
      ...(pos === undefined ? {} : { pos }),
      help: "Write `group: status`, or `group: { field: date, by: month }`.",
    }],
  });
  if (typeof raw === "string") {
    const field = raw.trim();
    return field === "" ? fail("`group` names no field.") : { spec: { field, ...DEFAULT_GROUP }, diagnostics: [] };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return fail("`group` is a field name, or a mapping with `field`, `by`, `order`, and `missing`.");
  }
  const value = raw as Record<string, unknown>;
  if (typeof value["field"] !== "string" || value["field"].trim() === "") return fail("`group` needs a `field`.");
  const by = value["by"] ?? "value";
  const order = value["order"] ?? "key";
  const missing = value["missing"] ?? DEFAULT_GROUP.missing;
  if (by !== "value" && by !== "year" && by !== "month") return fail("`group.by` is `value`, `year`, or `month`.");
  if (order !== "key" && order !== "size") return fail("`group.order` is `key` or `size`.");
  if (typeof missing !== "string") return fail("`group.missing` is the key of the group without a value.");
  return { spec: { field: value["field"], by, order, missing }, diagnostics: [] };
}

/** The group keys one row joins, in the order they are named. */
function keysOf(row: Row, spec: GroupSpec): readonly string[] {
  const found = resolveIn(row.fields, spec.field);
  if (spec.by === "year" || spec.by === "month") {
    const date = row.dates?.[spec.field] ?? scalarText(found.value);
    if (date === undefined || !/^\d{4}-\d{2}/.test(date)) return [spec.missing];
    return [spec.by === "year" ? date.slice(0, 4) : date.slice(0, 7)];
  }
  if (!found.found || found.value === undefined || found.value === null) return [spec.missing];
  const values = Array.isArray(found.value) ? found.value : [found.value];
  const keys = values.map((value) => scalarText(value)).filter((text): text is string => text !== undefined && text !== "");
  return keys.length === 0 ? [spec.missing] : keys;
}

/** Groups rows by the spec, with a record in a list field joining every group it names. */
export function groupRows<T extends Row>(rows: readonly T[], spec: GroupSpec): Grouping<T>[] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    for (const key of keysOf(row, spec)) {
      const members = groups.get(key);
      if (members === undefined) groups.set(key, [row]);
      else members.push(row);
    }
  }
  return [...groups.entries()]
    .map(([key, members]) => ({ key, rows: members }))
    .sort((a, b) =>
      spec.order === "size"
        ? b.rows.length - a.rows.length || compareCodePoint(a.key, b.key)
        : compareCodePoint(a.key, b.key),
    );
}
