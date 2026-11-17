/**
 * The Jalali (Solar Hijri) calendar, converted with a fixed arithmetic algorithm (the 33-year cycle with the published
 * break years, as in the widely used `jalaali-js`). It needs no `Intl`, so its answer never changes with the Node or ICU
 * version.
 */
import { type Day, dayNumber, isLeapYear } from "./parse.ts";

export type Calendar = "gregorian" | "jalali";

export const CALENDARS: readonly Calendar[] = ["gregorian", "jalali"];

const BREAKS = [-61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394, 2456, 3178];

const div = (a: number, b: number): number => Math.trunc(a / b);
const mod = (a: number, b: number): number => a - Math.trunc(a / b) * b;

/** The leap position of a Jalali year and the March day of its Nowruz. */
function jalCal(jy: number): { leap: number; gy: number; march: number } {
  const gy = jy + 621;
  let leapJ = -14;
  let jp = BREAKS[0]!;
  let jump = 0;
  for (let i = 1; i < BREAKS.length; i++) {
    const jm = BREAKS[i]!;
    jump = jm - jp;
    if (jy < jm) break;
    leapJ += div(jump, 33) * 8 + div(mod(jump, 33), 4);
    jp = jm;
  }
  let n = jy - jp;
  leapJ += div(n, 33) * 8 + div(mod(n, 33) + 3, 4);
  if (mod(jump, 33) === 4 && jump - n === 4) leapJ += 1;
  const leapG = div(gy, 4) - div((div(gy, 100) + 1) * 3, 4) - 150;
  const march = 20 + leapJ - leapG;
  if (jump - n < 6) n = n - jump + div(jump + 4, 33) * 33;
  let leap = mod(mod(n + 1, 33) - 1, 4);
  if (leap === -1) leap = 4;
  return { leap, gy, march };
}

/** Whether a Jalali year has 366 days. */
export function isJalaliLeap(jy: number): boolean {
  return jalCal(jy).leap === 0;
}

/** The days in a Jalali month. */
export function jalaliMonthLength(jy: number, jm: number): number {
  if (jm <= 6) return 31;
  if (jm <= 11) return 30;
  return isJalaliLeap(jy) ? 30 : 29;
}

/** Converts a Gregorian day to the Jalali day. */
export function toJalali(day: Day): Day {
  const gDay = dayNumber(day);
  let jy = day.year - 621;
  const r = jalCal(jy);
  let k = gDay - dayNumber({ year: r.gy, month: 3, day: r.march });
  if (k >= 0) {
    if (k <= 185) return { year: jy, month: 1 + div(k, 31), day: mod(k, 31) + 1 };
    k -= 186;
  } else {
    jy -= 1;
    k += 179;
    if (r.leap === 1) k += 1;
  }
  return { year: jy, month: 7 + div(k, 30), day: mod(k, 30) + 1 };
}

/** Converts a Jalali day to the Gregorian day, as a day count since 1970-01-01. */
export function jalaliDayNumber(day: Day): number {
  const r = jalCal(day.year);
  const offset = day.month <= 6 ? (day.month - 1) * 31 : 186 + (day.month - 7) * 30;
  return dayNumber({ year: r.gy, month: 3, day: r.march }) + offset + day.day - 1;
}

/** Whether a Gregorian year is leap; re-exported so callers need one import for calendar facts. */
export { isLeapYear };
