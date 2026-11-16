/**
 * The as-of date: the day a build pretends it is. It is always an input and never read inside the build.
 *
 * The `--as-of` flag wins over the config's `asOf` key. `--as-of today` is the one place a clock is read, and only the
 * CLI calls {@link todayOf}: it reads the system date once, prints it, and hands a plain `YYYY-MM-DD` on.
 */
import type { Diagnostic } from "../contracts/diagnostic.ts";
import type { SourcePos } from "../contracts/source.ts";
import { parseDate } from "./parse.ts";

/** Where the resolved date came from. */
export type AsOfSource = "flag" | "config";

/** The resolved as-of date, or none. */
export interface AsOf {
  /** `YYYY-MM-DD`. */
  readonly date: string;
  readonly source: AsOfSource;
}

/** Checks that a value is a single day; returns the problem when it is not. */
export function checkAsOf(value: string): string | undefined {
  const parsed = parseDate(value);
  if (!parsed.ok) return parsed.message;
  if (parsed.date.precision !== "day") return `"${value}" is not a day; an as-of date is written YYYY-MM-DD.`;
  return undefined;
}

/** The date of `now` in the machine's local calendar, as `YYYY-MM-DD`. Only the CLI edge calls this. */
export function todayOf(now: Date): string {
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** The result of reading a `--as-of` value. */
export type FlagResult =
  | { readonly ok: true; readonly date: string; readonly today: boolean }
  | { readonly ok: false; readonly message: string };

/** Reads the value of `--as-of`: a day, or `today`, which `readToday` answers once. */
export function readAsOfFlag(value: string, readToday: () => string): FlagResult {
  if (value === "today") return { ok: true, date: readToday(), today: true };
  const problem = checkAsOf(value);
  return problem === undefined ? { ok: true, date: value, today: false } : { ok: false, message: problem };
}

/** The as-of date of a build: the flag when given, otherwise the config's `asOf`. */
export function resolveAsOf(flag: string | undefined, configured: string | undefined): AsOf | undefined {
  if (flag !== undefined) return { date: flag, source: "flag" };
  if (configured !== undefined) return { date: configured, source: "config" };
  return undefined;
}

/**
 * The diagnostic for a feature that needs the as-of date when none is set. `feature` names what needs it, such as
 * "the derived value `daysLeft`", and `pos` is the place that needs it.
 */
export function missingAsOf(feature: string, pos?: SourcePos): Diagnostic {
  return {
    id: "dates.no-as-of",
    severity: "error",
    message: `${feature} needs an as-of date, and none is set.`,
    ...(pos === undefined ? {} : { pos }),
    help: "Pass `--as-of YYYY-MM-DD` (or `--as-of today`), or set `asOf` in the site config.",
  };
}
