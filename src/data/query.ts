/**
 * The query half of a list page: `where` picks records and `sort` orders them.
 *
 * `where` is a mapping and every entry has to match. A scalar is equality, a list is "one of", and a mapping with one
 * of `exists`, `before`, or `after` is the matching test. A date is written `YYYY-MM-DD`, a full ISO 8601 instant, or
 * `reference` with an optional `+Nd`, `-Nd`, `+Nm`, or `-Nm`: the reference date comes from the config, never the clock.
 *
 * `sort` names one or two fields, each optionally followed by `asc` or `desc`. Text compares by code point, numbers
 * compare as numbers, a record without a value sorts last, and equal keys fall back to the record id and then to source
 * order, so two builds always agree.
 */
import type { Diagnostic, SourcePos } from "../contracts/index.ts";
import { resolveIn, scalarText } from "./record-context.ts";

/** The part of a record a query reads. */
export interface Row {
  /** The record's id, the final tie-breaker of a sort. */
  readonly id: string;
  /** The record's fields, in the page's language. */
  readonly fields: Readonly<Record<string, unknown>>;
  /** Each date field's normalized value, keyed by field name. */
  readonly dates?: Readonly<Record<string, string>>;
}

/** One `where` test. */
export interface Condition {
  readonly field: string;
  readonly kind: "equals" | "one-of" | "exists" | "before" | "after";
  /** For an `exists` test: whether the field must hold a value. Default `true`. */
  readonly present?: boolean;
  /** The expected text of an equality. */
  readonly text?: string;
  /** The expected texts of a "one of" test. */
  readonly texts?: readonly string[];
  /** The instant a `before` or `after` test compares against, in milliseconds. */
  readonly instant?: number;
}

/** One sort key. */
export interface SortKey {
  readonly field: string;
  readonly desc: boolean;
}

/** What one list's `where` and `sort` became, and every finding made while reading them. */
export interface QueryParse {
  readonly where: readonly Condition[];
  readonly sort: readonly SortKey[];
  /** True when a condition compares against the reference date, so the caller can report a missing one. */
  readonly needsReference: boolean;
  readonly diagnostics: readonly Diagnostic[];
}

/** Options of {@link parseQuery}: where the declaration sits, the collection, and its reference date. */
export interface QueryParseOptions {
  readonly file: string;
  readonly pos?: SourcePos;
  readonly collection: string;
  /** The collection's reference date, already resolved; unset when the config names none. */
  readonly reference?: string;
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Compares two strings by Unicode code point, never by locale or UTF-16 unit. */
export function compareCodePoint(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const difference = left[index]!.codePointAt(0)! - right[index]!.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

/** A date or instant as milliseconds since the epoch; undefined when the text is neither. */
export function instantOf(text: string): number | undefined {
  const value = text.trim();
  if (value === "") return undefined;
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (date !== null) {
    const time = Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3]));
    return Number.isNaN(time) ? undefined : time;
  }
  const instant = Date.parse(value);
  return Number.isNaN(instant) ? undefined : instant;
}

/** A date, moved by whole days or months, as `YYYY-MM-DD`. */
export function shiftDate(text: string, amount: number, unit: "d" | "m"): string | undefined {
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (date === null) return undefined;
  const moved = new Date(Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3])));
  if (unit === "d") moved.setUTCDate(moved.getUTCDate() + amount);
  else moved.setUTCMonth(moved.getUTCMonth() + amount);
  return moved.toISOString().slice(0, 10);
}

/** The date a `before` or `after` operand names, or the reason it names none. */
function dateOperand(raw: string, reference: string | undefined): { readonly date?: string; readonly relative: boolean } {
  const value = raw.trim();
  if (value === "reference") return reference === undefined ? { relative: true } : { date: reference, relative: true };
  const relative = /^reference([+-])(\d+)([dm])$/.exec(value);
  if (relative !== null) {
    const amount = relative[1] === "-" ? -Number(relative[2]) : Number(relative[2]);
    const moved = reference === undefined ? undefined : shiftDate(reference, amount, relative[3] as "d" | "m");
    return moved === undefined ? { relative: true } : { date: moved, relative: true };
  }
  return { date: value, relative: false };
}

/** The scalar text of a candidate value; a list matches when any item is a scalar. */
function textsOf(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const text = scalarText(item);
      return text === undefined ? [] : [text];
    });
  }
  const text = scalarText(value);
  return text === undefined ? [] : [text];
}

/** True when a field holds a value; an empty string, an empty list, `null`, and an absent field do not. */
function hasValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/** True when one record matches one condition. */
export function matchesCondition(row: Row, condition: Condition): boolean {
  const found = resolveIn(row.fields, condition.field);
  if (condition.kind === "exists") return hasValue(found.value) === (condition.present ?? true);
  if (condition.kind === "before" || condition.kind === "after") {
    if (condition.instant === undefined) return false;
    const raw = row.dates?.[condition.field] ?? scalarText(found.value);
    if (raw === undefined) return false;
    const instant = instantOf(raw);
    if (instant === undefined) return false;
    return condition.kind === "before" ? instant < condition.instant : instant > condition.instant;
  }
  const texts = textsOf(found.value);
  if (condition.kind === "equals") return texts.includes(condition.text ?? "");
  return texts.some((text) => (condition.texts ?? []).includes(text));
}

/** Keeps the rows every condition matches. */
export function filterRows<T extends Row>(rows: readonly T[], conditions: readonly Condition[]): T[] {
  if (conditions.length === 0) return [...rows];
  return rows.filter((row) => conditions.every((condition) => matchesCondition(row, condition)));
}

/** The comparable value of one row's field; an absent field is `undefined`. */
function valueOf(row: Row, field: string): unknown {
  const found = resolveIn(row.fields, field);
  return found.found ? found.value : undefined;
}

/** Orders two values: numbers numerically, everything else as text, and a missing value last. */
function compareValues(left: unknown, right: unknown): number {
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  return compareCodePoint(scalarText(left) ?? "", scalarText(right) ?? "");
}

/** Sorts rows by every key in turn, then by id, then by source order. */
export function sortRows<T extends Row>(rows: readonly T[], keys: readonly SortKey[]): T[] {
  if (keys.length === 0) return [...rows];
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      for (const key of keys) {
        const order = compareValues(valueOf(a.row, key.field), valueOf(b.row, key.field));
        if (order !== 0) return key.desc ? -order : order;
      }
      return compareCodePoint(a.row.id, b.row.id) || a.index - b.index;
    })
    .map((entry) => entry.row);
}

/** Reads one `sort` value: a string or up to two strings, each `field` or `field asc|desc`. */
function parseSort(raw: unknown, diagnostics: Diagnostic[], pos: SourcePos | undefined): SortKey[] {
  if (raw === undefined) return [];
  const list = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
  const fail = (message: string): void => {
    diagnostics.push({
      id: "data.list-sort",
      severity: "error",
      message,
      ...(pos === undefined ? {} : { pos }),
      help: "Write one or two field names, each optionally followed by `asc` or `desc`.",
    });
  };
  if (list.length === 0 || list.length > 2 || list.some((item) => typeof item !== "string")) {
    fail("`sort` is one field, or a list of one or two fields, each written as `field` or `field asc|desc`.");
    return [];
  }
  const keys: SortKey[] = [];
  for (const item of list as string[]) {
    const parts = item.trim().split(/\s+/).filter((part) => part !== "");
    const direction = parts.at(-1);
    const desc = direction === "desc";
    const field = desc || direction === "asc" ? parts.slice(0, -1).join(" ") : parts.join(" ");
    if (field === "") {
      fail(`The sort key "${item}" names no field.`);
      continue;
    }
    keys.push({ field, desc });
  }
  return keys;
}

/** Reads a date operand for one field, reporting a relative date without a reference date. */
function readDate(
  field: string,
  raw: unknown,
  options: QueryParseOptions,
  diagnostics: Diagnostic[],
): number | undefined {
  if (typeof raw !== "string") {
    diagnostics.push({
      id: "data.list-where",
      severity: "error",
      message: `The date test on "${field}" needs a date written as \`YYYY-MM-DD\`, an ISO 8601 instant, or \`reference\`.`,
      ...(options.pos === undefined ? {} : { pos: options.pos }),
      help: "Write before: 2026-01-01, or before: reference.",
    });
    return undefined;
  }
  const operand = dateOperand(raw, options.reference);
  if (operand.relative && operand.date === undefined) {
    diagnostics.push({
      id: "data.reference-date",
      severity: "error",
      message: `The list compares "${field}" with the reference date, but ${options.collection} has no reference date.`,
      ...(options.pos === undefined ? {} : { pos: options.pos }),
      help: `Set \`collections.${options.collection}.referenceDate\` to a date, or to the path of a _data value that holds one.`,
    });
    return undefined;
  }
  const instant = operand.date === undefined ? undefined : instantOf(operand.date);
  if (instant === undefined) {
    diagnostics.push({
      id: "data.list-where",
      severity: "error",
      message: `The date test on "${field}" does not name a valid date.`,
      ...(options.pos === undefined ? {} : { pos: options.pos }),
      help: "Write a date as `YYYY-MM-DD`, an ISO 8601 instant, or `reference` with an optional offset such as `reference-7d`.",
    });
  }
  return instant;
}

/** Reads one `where` value into the conditions it means. */
function readCondition(
  field: string,
  raw: unknown,
  options: QueryParseOptions,
  diagnostics: Diagnostic[],
): Condition[] {
  const fail = (message: string, help: string): void => {
    diagnostics.push({
      id: "data.list-where",
      severity: "error",
      message,
      ...(options.pos === undefined ? {} : { pos: options.pos }),
      help,
    });
  };
  if (Array.isArray(raw)) {
    const texts = raw.map((item) => scalarText(item));
    if (texts.some((text) => text === undefined)) {
      fail(`The "one of" test on "${field}" holds a value that is not a scalar.`, "Write the values as text, numbers, or booleans.");
      return [];
    }
    return [{ field, kind: "one-of", texts: texts as string[] }];
  }
  if (isMapping(raw)) {
    const keys = Object.keys(raw).filter((key) => raw[key] !== undefined);
    if (keys.length !== 1) {
      fail(`The test on "${field}" is a mapping with one of \`exists\`, \`before\`, or \`after\`.`, `Write \`${field}: { exists: true }\`, or a plain value for equality.`);
      return [];
    }
    const kind = keys[0]!;
    if (kind === "exists") {
      if (typeof raw.exists !== "boolean") {
        fail(`\`exists\` on "${field}" is \`true\` or \`false\`.`, `Write \`${field}: { exists: true }\`.`);
        return [];
      }
      return raw.exists ? [{ field, kind: "exists" }] : [{ field, kind: "exists", present: false }];
    }
    if (kind === "before" || kind === "after") {
      const instant = readDate(field, raw[kind], options, diagnostics);
      return instant === undefined ? [] : [{ field, kind, instant }];
    }
    fail(`The test on "${field}" uses "${kind}", which is not a list test.`, "The tests are `exists`, `before`, and `after`; a plain value is equality.");
    return [];
  }
  const text = scalarText(raw);
  if (text === undefined) {
    fail(`The value of "${field}" is not a scalar.`, "Write a string, number, or boolean, a list for \"one of\", or a mapping for a date or existence test.");
    return [];
  }
  return [{ field, kind: "equals", text }];
}

/**
 * Reads one page's `where` and `sort`. A shape the engine cannot read is an error at the `list` key, and the list then
 * matches every record and keeps source order rather than guessing.
 */
export function parseQuery(rawWhere: unknown, rawSort: unknown, options: QueryParseOptions): QueryParse {
  const diagnostics: Diagnostic[] = [];
  const sort = parseSort(rawSort, diagnostics, options.pos);
  if (rawWhere === undefined) return { where: [], sort, needsReference: false, diagnostics };
  if (!isMapping(rawWhere)) {
    diagnostics.push({
      id: "data.list-where",
      severity: "error",
      message: "`where` is a mapping of field names to tests.",
      ...(options.pos === undefined ? {} : { pos: options.pos }),
      help: "Write `where: { status: stable }`.",
    });
    return { where: [], sort, needsReference: false, diagnostics };
  }
  const where: Condition[] = [];
  let needsReference = false;
  for (const [field, value] of Object.entries(rawWhere)) {
    if (isMapping(value) && (value["before"] !== undefined || value["after"] !== undefined)) needsReference = true;
    where.push(...readCondition(field, value, options, diagnostics));
  }
  return { where, sort, needsReference, diagnostics };
}
