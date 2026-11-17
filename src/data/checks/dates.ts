/**
 * Date checks for the fields a collection marks under `dates`. An accepted value is `YYYY-MM-DD`, `YYYY-MM`, or
 * `YYYY`, or a full ISO 8601 instant; an impossible or unrecognized date is one error at the field's span.
 *
 * The value is kept exactly as the source writes it, and the record also carries a normalized form for a theme:
 * a calendar date stays as written, an instant becomes its UTC ISO 8601 form. Nothing here reads the clock: two builds
 * of the same input give the same strings.
 */
import type { DataRecord, Diagnostic, RecordPos } from "../../contracts/index.ts";
import { normalizeDate } from "../../dates/parse.ts";
import { sourcePosOf } from "../positions.ts";

/** The help every date finding carries, naming both accepted shapes. */
export const DATE_HELP =
  "Write `YYYY-MM-DD`, `YYYY-MM`, or `YYYY`, or a full ISO 8601 instant such as `2026-01-31T09:00:00Z`.";

export { normalizeDate };

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
