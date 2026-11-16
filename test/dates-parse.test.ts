import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compareToDay,
  dayFromNumber,
  dayNumber,
  earliestDay,
  formatDay,
  latestDay,
  parseDate,
  weekday,
} from "../src/dates/parse.ts";

function ok(text: string) {
  const r = parseDate(text);
  assert.ok(r.ok, `${text} should parse`);
  return r.date;
}

test("reads the three forms with their precision", () => {
  assert.deepEqual(ok("2026-03-09"), { precision: "day", year: 2026, month: 3, day: 9 });
  assert.deepEqual(ok("2026-03"), { precision: "month", year: 2026, month: 3 });
  assert.deepEqual(ok("2026"), { precision: "year", year: 2026 });
});

test("a partial date spans its earliest and latest day", () => {
  assert.equal(formatDay(earliestDay(ok("2026-02"))), "2026-02-01");
  assert.equal(formatDay(latestDay(ok("2026-02"))), "2026-02-28");
  assert.equal(formatDay(latestDay(ok("2028-02"))), "2028-02-29");
  assert.equal(formatDay(earliestDay(ok("2026"))), "2026-01-01");
  assert.equal(formatDay(latestDay(ok("2026"))), "2026-12-31");
  assert.equal(formatDay(latestDay(ok("2026-04-10"))), "2026-04-10");
});

test("leap years follow the Gregorian rule", () => {
  for (const y of ["2000-02-29", "2024-02-29"]) assert.ok(parseDate(y).ok);
  for (const y of ["1900-02-29", "2026-02-29", "2100-02-29"]) assert.equal(parseDate(y).ok, false);
});

test("month ends are checked", () => {
  assert.ok(parseDate("2026-01-31").ok);
  assert.ok(parseDate("2026-04-30").ok);
  assert.equal(parseDate("2026-04-31").ok, false);
  assert.equal(parseDate("2026-02-30").ok, false);
});

test("every rejected form names the position of the value", () => {
  const cases: Array<[string, number, number]> = [
    ["2026-02-30", 8, 2],
    ["2026-13", 5, 2],
    ["2026-00-10", 5, 2],
    ["2026-01-00", 8, 2],
    ["0000", 0, 4],
    ["2026-1-5", 0, 8],
    ["26-01-05", 0, 8],
    ["", 0, 0],
    ["2026-01-05T10:00:00Z", 0, 20],
    ["2026/01/05", 0, 10],
    [" 2026", 0, 5],
    ["2026-01-05 ", 0, 11],
  ];
  for (const [text, offset, length] of cases) {
    const r = parseDate(text);
    assert.equal(r.ok, false, text);
    if (!r.ok) {
      assert.equal(r.offset, offset, `${text} offset`);
      assert.equal(r.length, length, `${text} length`);
      assert.ok(r.message.length > 0);
    }
  }
});

test("day numbers round trip and match known days", () => {
  assert.equal(dayNumber({ year: 1970, month: 1, day: 1 }), 0);
  assert.equal(dayNumber({ year: 2000, month: 3, day: 1 }), 11017);
  assert.equal(dayNumber({ year: 1969, month: 12, day: 31 }), -1);
  for (const n of [-800000, -1, 0, 59, 60, 11016, 11017, 20000, 2932896]) {
    assert.equal(dayNumber(dayFromNumber(n)), n);
  }
  assert.equal(formatDay(dayFromNumber(11016)), "2000-02-29");
});

test("weekday is fixed by the calendar", () => {
  assert.equal(weekday({ year: 1970, month: 1, day: 1 }), 4);
  assert.equal(weekday({ year: 2026, month: 11, day: 15 }), 0);
});

test("a partial date compares to a day by its range", () => {
  const day = { year: 2026, month: 3, day: 15 };
  assert.equal(compareToDay(ok("2026-02"), day), "before");
  assert.equal(compareToDay(ok("2026-04"), day), "after");
  assert.equal(compareToDay(ok("2026-03"), day), "contains");
  assert.equal(compareToDay(ok("2026"), day), "contains");
  assert.equal(compareToDay(ok("2025"), day), "before");
  assert.equal(compareToDay(ok("2026-03-15"), day), "contains");
  assert.equal(compareToDay(ok("2026-03-14"), day), "before");
});
