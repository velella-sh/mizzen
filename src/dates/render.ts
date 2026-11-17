/**
 * Reads and formats a date value a record holds. A value is a day (`YYYY-MM-DD`), a month, a year, or a full ISO 8601
 * instant; an instant is formatted as its UTC day. Formatting never reads a clock and never uses `Intl`, so the same
 * value and the same language and calendar give the same text on every machine.
 */
import type { Calendar } from "./calendars.ts";
import { formatDate, type DateStyle, type Formatted } from "./format.ts";
import { normalizeDate, parseDate, type PartialDate } from "./parse.ts";

/** The date a record value means, or `undefined` when it is not a date. */
export function dateOf(value: unknown): PartialDate | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const parsed = parseDate(value);
  if (parsed.ok) return parsed.date;
  const normalized = normalizeDate(value);
  if (normalized === undefined) return undefined;
  const day = parseDate(normalized.slice(0, 10));
  return day.ok ? day.date : undefined;
}

/** Formats a record's date value for a language tag and a calendar, or says why it cannot. */
export function renderDate(
  value: unknown,
  tag: string | undefined,
  calendar: Calendar,
  style: DateStyle,
): Formatted {
  const date = dateOf(value);
  if (date === undefined) return { ok: false, message: `"${String(value)}" is not a date.` };
  return formatDate(date, tag, calendar, style);
}
