/**
 * Formats a date for a language and a calendar from built-in tables. It never uses `Intl`: the output of `Intl` changes
 * with the Node and ICU version and would break byte-identical builds.
 *
 * Languages are `en`, `fa`, and `ar`; a region suffix such as `fa-IR` is ignored and any other language is written as
 * `en`. Only a day can be written in the Jalali calendar, because a Gregorian month or year does not match a Jalali one.
 */
import { type Calendar, toJalali } from "./calendars.ts";
import { type Day, type PartialDate, earliestDay, weekday } from "./parse.ts";

export type DateLanguage = "en" | "fa" | "ar";

/** `short` is numeric, `long` writes the month name, `full` adds the weekday. */
export type DateStyle = "short" | "long" | "full";

export const DATE_STYLES: readonly DateStyle[] = ["short", "long", "full"];

const GREGORIAN_MONTHS: Record<DateLanguage, readonly string[]> = {
  en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
  fa: ["ژانویه", "فوریه", "مارس", "آوریل", "مه", "ژوئن", "ژوئیه", "اوت", "سپتامبر", "اکتبر", "نوامبر", "دسامبر"],
  ar: ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"],
};

const JALALI_MONTHS: Record<DateLanguage, readonly string[]> = {
  en: ["Farvardin", "Ordibehesht", "Khordad", "Tir", "Mordad", "Shahrivar", "Mehr", "Aban", "Azar", "Dey", "Bahman", "Esfand"],
  fa: ["فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور", "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند"],
  ar: ["فروردين", "أرديبهشت", "خرداد", "تير", "مرداد", "شهريور", "مهر", "آبان", "آذر", "دي", "بهمن", "إسفند"],
};

/** Sunday first. */
const WEEKDAYS: Record<DateLanguage, readonly string[]> = {
  en: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
  fa: ["یکشنبه", "دوشنبه", "سه‌شنبه", "چهارشنبه", "پنجشنبه", "جمعه", "شنبه"],
  ar: ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"],
};

const DIGITS: Record<DateLanguage, readonly string[]> = {
  en: ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"],
  fa: ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"],
  ar: ["٠", "١", "٢", "٣", "٤", "٥", "٦", "٧", "٨", "٩"],
};

/** The supported language of a language tag; anything else is `en`. */
export function dateLanguage(tag: string | undefined): DateLanguage {
  const base = (tag ?? "").toLowerCase().split(/[-_]/, 1)[0];
  return base === "fa" || base === "ar" ? base : "en";
}

/** Writes a whole number with the digits of a language. */
export function localDigits(value: number | string, language: DateLanguage): string {
  const table = DIGITS[language];
  return String(value).replace(/\d/g, (d) => table[Number(d)]!);
}

/** The result of formatting: the text, or why the date cannot be written that way. */
export type Formatted = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string };

function two(n: number): string {
  return String(n).padStart(2, "0");
}

/** Formats a date for a language tag and a calendar. */
export function formatDate(date: PartialDate, tag: string | undefined, calendar: Calendar, style: DateStyle): Formatted {
  const language = dateLanguage(tag);
  const digits = (v: number | string): string => localDigits(v, language);
  if (calendar === "jalali" && date.precision !== "day") {
    return {
      ok: false,
      message: "a month or a year cannot be written in the Jalali calendar; write a full date or use the Gregorian calendar.",
    };
  }
  const gregorian: Day = earliestDay(date);
  const day: Day = calendar === "jalali" ? toJalali(gregorian) : gregorian;
  const months = calendar === "jalali" ? JALALI_MONTHS[language] : GREGORIAN_MONTHS[language];
  const year = String(day.year).padStart(4, "0");

  if (style === "short") {
    const parts = [year];
    if (date.precision !== "year") parts.push(two(day.month));
    if (date.precision === "day") parts.push(two(day.day));
    return { ok: true, text: digits(parts.join("-")) };
  }
  if (date.precision === "year") return { ok: true, text: digits(day.year) };
  const month = months[day.month - 1]!;
  if (date.precision === "month") return { ok: true, text: `${month} ${digits(day.year)}` };
  const core = `${digits(day.day)} ${month} ${digits(day.year)}`;
  if (style === "long") return { ok: true, text: core };
  const name = WEEKDAYS[language][weekday(gregorian)]!;
  return { ok: true, text: language === "en" ? `${name}, ${core}` : `${name}، ${core}` };
}
