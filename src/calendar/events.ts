/**
 * Builds a record's calendar events from its date fields.
 *
 * Each configured event reads one date field (and, for a run of days, one end field). A record whose field is empty or
 * is not a date gets no such event: a date is never guessed, and the number skipped is returned so the build can say so.
 */
import type { CalendarEventConfig } from "../contracts/config.ts";
import type { DataRecord } from "../contracts/data.ts";
import { resolveIn, scalarText } from "../data/record-context.ts";
import { dayOf } from "./uid.ts";

/** One event of one record, before it becomes an ICS event. */
export interface RecordEvent {
  /** The event's name from the config. */
  readonly name: string;
  /** First day, `YYYY-MM-DD`. */
  readonly start: string;
  /** Last day, `YYYY-MM-DD`, when the event lasts more than one day. */
  readonly end?: string;
  readonly title: string;
}

/** The events of one record and how many configured events it had no date for. */
export interface RecordEvents {
  readonly events: readonly RecordEvent[];
  readonly skipped: number;
}

/** The default title template. */
export const DEFAULT_TITLE = "{title}";

/** Fills `{field}` from the record's fields; a field with no scalar value fills as nothing. */
export function fillTemplate(template: string, fields: Readonly<Record<string, unknown>>): string {
  return template
    .replace(/\{([^{}]+)\}/g, (_, path: string) => {
      const found = resolveIn(fields, path.trim());
      return found.found ? (scalarText(found.value) ?? "") : "";
    })
    .replace(/\s+/g, " ")
    .trim();
}

/** The day a date field holds on this record: the normalized form when the loader made one, else the field read as a date. */
function dayOfField(record: DataRecord, field: string): string | undefined {
  const normalized = record.normalizedDates?.[field];
  if (normalized !== undefined) return dayOf(normalized);
  return dayOf(record.fields[field]);
}

/** Builds a record's events in the order the config lists them. */
export function recordEvents(record: DataRecord, configured: readonly CalendarEventConfig[]): RecordEvents {
  const events: RecordEvent[] = [];
  let skipped = 0;
  for (const event of configured) {
    const start = dayOfField(record, event.field);
    if (start === undefined) {
      skipped += 1;
      continue;
    }
    const last = event.end === undefined ? undefined : dayOfField(record, event.end);
    const title = fillTemplate(event.title ?? DEFAULT_TITLE, record.fields) || record.id;
    events.push({ name: event.name, start, ...(last !== undefined && last > start ? { end: last } : {}), title });
  }
  return { events, skipped };
}
