/**
 * Values computed from a record's date against the build's as-of date, once per build. A rule either counts whole days
 * (`days-left` to the date's latest day, `days-since` from its earliest) or picks a value from bands of that count.
 *
 * A record without the date has no value for that rule; an absent value is not a finding. A collection with rules and no
 * as-of date reports `dates.no-as-of` once per rule and derives nothing. The values live beside the record's fields and
 * are never written back to the data file: a real field with the same name wins when a page reads them.
 */
import type { DataRecord, DerivedRuleConfig, Diagnostic, SourcePos } from "../contracts/index.ts";
import { missingAsOf } from "../dates/as-of.ts";
import { dayNumber, earliestDay, latestDay, parseDate, type PartialDate } from "../dates/parse.ts";
import { dateOf } from "../dates/render.ts";

/** The records with their derived values, and the findings from rules that could not run. */
export interface DerivedResult {
  readonly records: readonly DataRecord[];
  readonly diagnostics: readonly Diagnostic[];
}

/** The whole days between the as-of day and one date, in the rule's direction. */
function countOf(rule: { readonly field: string; readonly kind: "days-left" | "days-since" }, date: PartialDate, asOf: number): number {
  return rule.kind === "days-left"
    ? dayNumber(latestDay(date)) - asOf
    : asOf - dayNumber(earliestDay(date));
}

/** The value a banded rule gives a count: the first band whose exclusive `below` the count is under. */
function bandOf(bands: readonly { readonly below?: number; readonly value: string | number | boolean }[], count: number): string | number | boolean | undefined {
  return bands.find((band) => band.below === undefined || count < band.below)?.value;
}

/**
 * Computes every collection's derived values against `asOf`. Rules run in config order, and a record keeps its source
 * order and every other field.
 */
export function deriveRecords(
  collection: string,
  records: readonly DataRecord[],
  rules: Readonly<Record<string, DerivedRuleConfig>> | undefined,
  asOf: string | undefined,
  pos?: SourcePos,
): DerivedResult {
  const names = Object.keys(rules ?? {});
  if (names.length === 0) return { records, diagnostics: [] };
  const parsed = asOf === undefined ? undefined : parseDate(asOf);
  if (parsed === undefined || !parsed.ok || parsed.date.precision !== "day") {
    return {
      records,
      diagnostics: names.map((name) => missingAsOf(`The derived value "${name}" of "${collection}"`, pos)),
    };
  }
  const asOfDay = dayNumber(earliestDay(parsed.date));

  return {
    records: records.map((record) => {
      const derived: Record<string, unknown> = {};
      for (const name of names) {
        const rule = rules![name]!;
        const date = dateOf(record.fields[rule.field]);
        if (date === undefined) continue;
        if ("bands" in rule) {
          const value = bandOf(rule.bands, dayNumber(latestDay(date)) - asOfDay);
          if (value !== undefined) derived[name] = value;
          continue;
        }
        derived[name] = countOf(rule, date, asOfDay);
      }
      return Object.keys(derived).length === 0 ? record : { ...record, derived };
    }),
    diagnostics: [],
  };
}

/** A record's fields with its derived values underneath: a real field with the same name wins. */
export function fieldsWithDerived(record: {
  readonly fields: Readonly<Record<string, unknown>>;
  readonly derived?: Readonly<Record<string, unknown>> | undefined;
}): Readonly<Record<string, unknown>> {
  if (record.derived === undefined) return record.fields;
  return { ...record.derived, ...record.fields };
}
