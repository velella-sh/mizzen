/**
 * Date checks for the fields a collection marks under `dates`. An accepted value is `YYYY-MM-DD` or a full ISO 8601
 * instant; an impossible or unrecognized date is one error at the field's span.
 *
 * The value is kept exactly as the source writes it, and the record also carries a normalized form for a theme:
 * `YYYY-MM-DD` stays as written, an instant becomes its UTC ISO 8601 form. Nothing here reads the clock: two builds
 * of the same input give the same strings.
 */
import type { DataRecord, Diagnostic, RecordPos } from "../../contracts/index.ts";
import { sourcePosOf } from "../positions.ts";

/** The help every date finding carries, naming both accepted shapes. */
export const DATE_HELP =
  "Write `YYYY-MM-DD`, such as `2026-01-31`, or a full ISO 8601 instant such as `2026-01-31T09:00:00Z`.";

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/** True when the three parts name a day that exists in the proleptic Gregorian calendar. */
function realDay(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1]!;
}

/** The normalized form of an accepted date, or `undefined` when the value is not a date. */
export function normalizeDate(value: string): string | undefined {
  const date = DATE.exec(value);
  if (date !== null) {
    const [year, month, day] = [Number(date[1]), Number(date[2]), Number(date[3])] as const;
    return realDay(year, month, day) ? value : undefined;
  }
  const instant = INSTANT.exec(value);
  if (instant === null) return undefined;
  const [year, month, day, hour, minute, second] = instant.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (!realDay(year, month, day) || hour > 23 || minute > 59 || second > 59) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/**
 * Checks each date field of each record and returns the records with `normalizedDates` set. An empty value is not a
 * date and is not a problem; a value that is not text or does not name a real day is one error at the field.
 */
export function applyDates(
  collection: string,
  records: readonly DataRecord[],
  fields: readonly string[],
  diagnostics: Diagnostic[],
): readonly DataRecord[] {
  if (fields.length === 0) return records;

  return records.map((record) => {
    let normalized: Record<string, string> | undefined;
    for (const field of fields) {
      const value = record.fields[field];
      if (value === undefined || value === null || value === "") continue;
      const pos: RecordPos = record.fieldPositions[field] ?? record.position;
      const normalizedValue = typeof value === "string" ? normalizeDate(value) : undefined;
      if (normalizedValue === undefined) {
        diagnostics.push({
          id: "data.date-invalid",
          severity: "error",
          message:
            typeof value === "string"
              ? `Field "${field}" of record "${record.id}" in "${collection}" is not a valid date: "${value}".`
              : `Field "${field}" of record "${record.id}" in "${collection}" must be a date written as text.`,
          pos: sourcePosOf(pos),
          help: DATE_HELP,
        });
        continue;
      }
      normalized ??= {};
      normalized[field] = normalizedValue;
    }
    return normalized === undefined ? record : { ...record, normalizedDates: normalized };
  });
}
