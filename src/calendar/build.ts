/**
 * The events one declared calendar lists, shared by the `calendars` output and the per-record calendar so the two never
 * disagree about an event's id, stamp, or title.
 *
 * A calendar lists a collection's records through the same `where` a list page uses. Every id and stamp comes from the
 * data (see `uid.ts`); a record whose stamp cannot be found is reported and left out rather than given the clock.
 */
import type { CalendarConfig, Site } from "../contracts/index.ts";
import type { Diagnostic } from "../contracts/diagnostic.ts";
import { filterRows, parseQuery } from "../data/query.ts";
import { localizeFields, resolveIn, scalarText } from "../data/record-context.ts";
import { referenceDateOf } from "../data/reference-date.ts";
import { indexRecords } from "../outputs/search-shared.ts";
import { recordEvents } from "./events.ts";
import type { IcsEvent } from "./ics.ts";
import { alarmsFor, parseReminders } from "./reminders.ts";
import { eventUid, stampOf } from "./uid.ts";

/** One event of the calendar and the group values of the record it belongs to. */
export interface CalendarEvent {
  readonly record: string;
  readonly event: IcsEvent;
  /** The record's values of `groupBy`, each once; empty when the calendar has no `groupBy` or the record has no value. */
  readonly groups: readonly string[];
}

/** What a calendar lists. */
export interface CalendarEvents {
  /** Events ordered by first day, then by id. */
  readonly events: readonly CalendarEvent[];
  /** Configured events skipped because a record had no date for them. */
  readonly skipped: number;
}

/** Compares by code point, never by locale. */
export function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function groupValues(value: unknown): string[] {
  const items = Array.isArray(value) ? value : [value];
  const out = new Set<string>();
  for (const item of items) {
    const text = scalarText(item)?.trim();
    if (text !== undefined && text !== "") out.add(text);
  }
  return [...out].sort(byCodePoint);
}

/** The events of one declared calendar. `origin` is the site's origin: its host goes into every id. */
export function calendarEvents(
  site: Site,
  name: string,
  calendar: CalendarConfig,
  origin: string,
  report: (diagnostic: Diagnostic) => void = () => {},
  only?: string,
): CalendarEvents {
  const collection = site.collections[calendar.collection];
  // The config loader reports a calendar that names a collection the site does not declare.
  if (collection === undefined) return { events: [], skipped: 0 };

  const reference = referenceDateOf(calendar.collection, site.config.collections[calendar.collection], site.data);
  if (reference.error !== undefined) report({ id: "calendars.reference-date", severity: "error", message: reference.error });
  const query = parseQuery(calendar.where, undefined, {
    file: "mizzen.yml",
    collection: calendar.collection,
    ...(reference.date === undefined ? {} : { reference: reference.date }),
  });
  for (const diagnostic of query.diagnostics) report(diagnostic);

  const { days, rejected } = parseReminders(calendar.reminders);
  for (const bad of rejected) {
    report({
      id: "calendars.reminder",
      severity: "error",
      message: `The calendar "${name}" has the reminder "${bad}", which is not a whole number of days.`,
      help: "Write a reminder as days, such as `30d`.",
    });
  }

  const rows = indexRecords(site, calendar.collection)
    .filter(({ record }) => only === undefined || record.id === only)
    .map(({ record, page }) => ({
      id: record.id,
      fields: localizeFields(record.fields, site.config.lang, site.config.lang).fields,
      ...(record.normalizedDates === undefined ? {} : { dates: record.normalizedDates }),
      record,
      page,
    }));

  const events: CalendarEvent[] = [];
  let skipped = 0;
  for (const row of filterRows(rows, query.where)) {
    const built = recordEvents({ ...row.record, fields: row.fields }, calendar.events);
    skipped += built.skipped;
    if (built.events.length === 0) continue;
    const stamp = stampOf({
      updated: row.fields["updated"],
      snapshot: collection.snapshot?.capturedAt,
      asOf: reference.date,
    });
    if (stamp === undefined) {
      report({
        id: "calendars.no-stamp",
        severity: "error",
        message: `The record "${row.record.id}" of the calendar "${name}" has no \`updated\` date, and the collection has no snapshot date or reference date to stamp it with.`,
        help: "Give the record an `updated` field, record a snapshot, or set `referenceDate` on the collection.",
      });
      continue;
    }
    const groups = calendar.groupBy === undefined ? [] : groupValues(resolveIn(row.fields, calendar.groupBy).value);
    const url = new URL(row.page.url, origin).href;
    for (const item of built.events) {
      events.push({
        record: row.record.id,
        groups,
        event: {
          uid: eventUid({ origin, collection: calendar.collection, record: row.record.id, event: item.name }),
          stamp,
          start: item.start,
          ...(item.end === undefined ? {} : { end: item.end }),
          summary: item.title,
          url,
          ...(days.length === 0 ? {} : { alarms: alarmsFor(days, item.title, row.fields) }),
        },
      });
    }
  }

  events.sort((a, b) => byCodePoint(a.event.start, b.event.start) || byCodePoint(a.event.uid, b.event.uid));
  return { events, skipped };
}
