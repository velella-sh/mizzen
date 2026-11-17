/**
 * Calendar dates with a precision: `YYYY-MM-DD`, `YYYY-MM`, and `YYYY`.
 *
 * A date has no time and no zone. Nothing here uses `new Date(string)` or a local time zone: a day is a year, a month,
 * and a day number, and a day count comes from a fixed civil-day algorithm, so results never change with the machine.
 */

/** How much of the date was written. */
export type DatePrecision = "day" | "month" | "year";

/** One parsed date. `month` and `day` are present only as far as the precision reaches. */
export interface PartialDate {
  readonly precision: DatePrecision;
  readonly year: number;
  readonly month?: number;
  readonly day?: number;
}

/** A plain day. */
export interface Day {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** The result of reading a value: a date, or why it is not one. */
export type ParsedDate =
  | { readonly ok: true; readonly date: PartialDate }
  | { readonly ok: false; readonly message: string; readonly offset: number; readonly length: number };

/** Whether `year` is a Gregorian leap year. */
export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** The number of days in a month of the Gregorian calendar. */
export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

const PATTERN = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;

/**
 * Reads `YYYY-MM-DD`, `YYYY-MM`, or `YYYY`. A rejected value reports the offset and length of the part at fault inside
 * `text`, so the caller can place the diagnostic on the value.
 */
export function parseDate(text: string): ParsedDate {
  const match = PATTERN.exec(text);
  if (match === null) {
    return { ok: false, message: `"${text}" is not a date; write YYYY-MM-DD, YYYY-MM, or YYYY.`, offset: 0, length: text.length };
  }
  const year = Number(match[1]);
  if (year < 1) return { ok: false, message: `"${text}" has year 0000, which is not a year.`, offset: 0, length: 4 };
  if (match[2] === undefined) return { ok: true, date: { precision: "year", year } };
  const month = Number(match[2]);
  if (month < 1 || month > 12) {
    return { ok: false, message: `"${text}" has month ${match[2]}, which is not from 01 to 12.`, offset: 5, length: 2 };
  }
  if (match[3] === undefined) return { ok: true, date: { precision: "month", year, month } };
  const day = Number(match[3]);
  const last = daysInMonth(year, month);
  if (day < 1 || day > last) {
    return {
      ok: false,
      message: `"${text}" has day ${match[3]}, but ${match[1]}-${match[2]} has ${last} days.`,
      offset: 8,
      length: 2,
    };
  }
  return { ok: true, date: { precision: "day", year, month, day } };
}

/** The earliest day a date can mean. */
export function earliestDay(date: PartialDate): Day {
  return { year: date.year, month: date.month ?? 1, day: date.day ?? 1 };
}

/** The latest day a date can mean. */
export function latestDay(date: PartialDate): Day {
  const month = date.month ?? 12;
  return { year: date.year, month, day: date.day ?? daysInMonth(date.year, month) };
}

/** Days since 1970-01-01 of a day, by the civil-day algorithm; no clock and no zone. */
export function dayNumber(day: Day): number {
  const y = day.month <= 2 ? day.year - 1 : day.year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (day.month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + day.day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** The day that has the given count of days since 1970-01-01. */
export function dayFromNumber(n: number): Day {
  const z = n + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: yoe + era * 400 + (month <= 2 ? 1 : 0), month, day };
}

/** The weekday of a day, 0 for Sunday through 6 for Saturday. */
export function weekday(day: Day): number {
  return (((dayNumber(day) + 4) % 7) + 7) % 7;
}

/** Writes a day as `YYYY-MM-DD`. */
export function formatDay(day: Day): string {
  return `${String(day.year).padStart(4, "0")}-${String(day.month).padStart(2, "0")}-${String(day.day).padStart(2, "0")}`;
}

/** Orders two days: negative when `a` is earlier, zero when equal, positive when later. */
export function compareDays(a: Day, b: Day): number {
  return dayNumber(a) - dayNumber(b);
}

/** How a date stands against a day: wholly before it, wholly after it, or covering it. */
export function compareToDay(date: PartialDate, day: Day): "before" | "after" | "contains" {
  if (compareDays(latestDay(date), day) < 0) return "before";
  if (compareDays(earliestDay(date), day) > 0) return "after";
  return "contains";
}
