/**
 * Reminders: a calendar's `reminders` list (`30d`, `7d`) becomes one `VALARM` per entry on every event.
 *
 * A reminder is a whole number of days. Anything else is refused, and no reminder is written unless the calendar asks for it.
 */
import type { IcsAlarm } from "./ics.ts";
import { fillTemplate } from "./events.ts";

/** The text of a reminder when the config gives none. `{days}` is the lead time, `{title}` the event's title. */
export const DEFAULT_REMINDER_TEXT = "{title} in {days} days";

const WHOLE_DAYS = /^([1-9][0-9]{0,3})d$/;

/** A reminder like `30d` as its number of days; undefined for any other form (hours, weeks, zero, fractions, signs). */
export function reminderDays(text: unknown): number | undefined {
  if (typeof text !== "string") return undefined;
  const match = WHOLE_DAYS.exec(text.trim());
  return match === null ? undefined : Number(match[1]);
}

/** The reminders of a list, largest lead first, each once; and the entries that are not whole days. */
export function parseReminders(list: readonly unknown[] | undefined): { readonly days: readonly number[]; readonly rejected: readonly string[] } {
  const days = new Set<number>();
  const rejected: string[] = [];
  for (const item of list ?? []) {
    const value = reminderDays(item);
    if (value === undefined) rejected.push(String(item));
    else days.add(value);
  }
  return { days: [...days].sort((a, b) => b - a), rejected };
}

/** The alarms of one event: one per lead time, with text filled from the record's fields, the event's title, and the lead. */
export function alarmsFor(
  days: readonly number[],
  title: string,
  fields: Readonly<Record<string, unknown>>,
  template: string = DEFAULT_REMINDER_TEXT,
): IcsAlarm[] {
  return days.map((lead) => ({
    days: lead,
    description:
      fillTemplate(template, { ...fields, title, days: String(lead) }) || title,
  }));
}
