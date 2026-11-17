import assert from "node:assert/strict";
import { test } from "node:test";
import { isJalaliLeap, jalaliDayNumber, jalaliMonthLength, toJalali } from "../src/dates/calendars.ts";
import { formatDate } from "../src/dates/format.ts";
import { dayFromNumber, dayNumber, formatDay, parseDate } from "../src/dates/parse.ts";

function fmt(text: string, lang: string, cal: "gregorian" | "jalali", style: "short" | "long" | "full"): string {
  const p = parseDate(text);
  assert.ok(p.ok);
  const r = formatDate(p.date, lang, cal, style);
  assert.ok(r.ok, r.ok ? "" : r.message);
  return r.text;
}

test("Gregorian, three languages, three styles", () => {
  assert.equal(fmt("2026-03-15", "en", "gregorian", "short"), "2026-03-15");
  assert.equal(fmt("2026-03-15", "en", "gregorian", "long"), "15 March 2026");
  assert.equal(fmt("2026-03-15", "en", "gregorian", "full"), "Sunday, 15 March 2026");
  assert.equal(fmt("2026-03-15", "fa", "gregorian", "short"), "۲۰۲۶-۰۳-۱۵");
  assert.equal(fmt("2026-03-15", "fa", "gregorian", "long"), "۱۵ مارس ۲۰۲۶");
  assert.equal(fmt("2026-03-15", "fa", "gregorian", "full"), "یکشنبه، ۱۵ مارس ۲۰۲۶");
  assert.equal(fmt("2026-03-15", "ar", "gregorian", "short"), "٢٠٢٦-٠٣-١٥");
  assert.equal(fmt("2026-03-15", "ar", "gregorian", "long"), "١٥ مارس ٢٠٢٦");
  assert.equal(fmt("2026-03-15", "ar-EG", "gregorian", "full"), "الأحد، ١٥ مارس ٢٠٢٦");
});

test("partial dates are written to their precision", () => {
  assert.equal(fmt("2026-03", "en", "gregorian", "long"), "March 2026");
  assert.equal(fmt("2026-03", "en", "gregorian", "short"), "2026-03");
  assert.equal(fmt("2026", "fa", "gregorian", "long"), "۲۰۲۶");
});

test("Jalali, three languages", () => {
  assert.equal(fmt("2026-03-21", "en", "jalali", "long"), "1 Farvardin 1405");
  assert.equal(fmt("2026-03-21", "fa", "jalali", "long"), "۱ فروردین ۱۴۰۵");
  assert.equal(fmt("2026-03-21", "ar", "jalali", "short"), "١٤٠٥-٠١-٠١");
  assert.equal(fmt("2026-03-21", "fa", "jalali", "full"), "شنبه، ۱ فروردین ۱۴۰۵");
});

test("Jalali year boundary and leap year", () => {
  assert.equal(fmt("2025-03-20", "en", "jalali", "short"), "1403-12-30");
  assert.equal(fmt("2025-03-21", "en", "jalali", "short"), "1404-01-01");
  assert.equal(fmt("2026-03-20", "en", "jalali", "short"), "1404-12-29");
  assert.equal(fmt("2024-03-19", "en", "jalali", "short"), "1402-12-29");
  assert.equal(fmt("2024-03-20", "en", "jalali", "short"), "1403-01-01");
  assert.equal(fmt("2026-09-22", "en", "jalali", "short"), "1405-06-31");
  assert.equal(fmt("2026-09-23", "en", "jalali", "short"), "1405-07-01");
  assert.deepEqual([1399, 1403, 1408].map(isJalaliLeap), [true, true, true]);
  assert.deepEqual([1400, 1401, 1402, 1404, 1405].map(isJalaliLeap), [false, false, false, false, false]);
  assert.equal(jalaliMonthLength(1403, 12), 30);
  assert.equal(jalaliMonthLength(1404, 12), 29);
});

test("Jalali conversion round trips over a long span", () => {
  for (let n = dayNumber({ year: 1900, month: 1, day: 1 }); n < dayNumber({ year: 2100, month: 1, day: 1 }); n += 1) {
    const g = formatDay(dayFromNumber(n));
    const p = parseDate(g);
    assert.ok(p.ok && p.date.day !== undefined);
    const j = toJalali({ year: p.date.year, month: p.date.month!, day: p.date.day });
    assert.equal(jalaliDayNumber(j), n, g);
  }
});

test("a month or a year is refused in the Jalali calendar", () => {
  const p = parseDate("2026-03");
  assert.ok(p.ok);
  assert.equal(formatDate(p.date, "en", "jalali", "long").ok, false);
});

test("an unknown language is written as English", () => {
  assert.equal(fmt("2026-03-15", "de", "gregorian", "long"), "15 March 2026");
});
