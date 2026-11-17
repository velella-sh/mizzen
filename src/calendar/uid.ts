/**
 * Event ids, stamps, and revision numbers taken from the data.
 *
 * A calendar app treats a changed `UID` as a new event and a changed `DTSTAMP` as a change, so none of them may come
 * from the build clock or the page URL: two builds of the same data must give the same values, whenever they run.
 */
import { instantOf } from "../data/query.ts";

/** What an event id is built from. */
export interface EventIdParts {
  /** The site's origin; only its host is used. */
  readonly origin: string;
  readonly collection: string;
  /** The record's id, never its page URL, so a renamed record keeps its events. */
  readonly record: string;
  /** The event's name from the calendar config. */
  readonly event: string;
}

/** `collection/record/event@host`, each part percent-encoded so a `/` or `@` inside a part cannot make two ids collide. */
export function eventUid(parts: EventIdParts): string {
  const host = new URL(parts.origin).hostname;
  const enc = encodeURIComponent;
  return `${enc(parts.collection)}/${enc(parts.record)}/${enc(parts.event)}@${host}`;
}

/** A date or an ISO 8601 instant as its UTC day, `YYYY-MM-DD`; undefined when the value is neither. */
export function dayOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const instant = instantOf(value);
  return instant === undefined ? undefined : new Date(instant).toISOString().slice(0, 10);
}

/** The places a stamp can come from, in the order they are tried. */
export interface StampSources {
  /** The record's own `updated` field. */
  readonly updated?: unknown;
  /** The collection's snapshot date (`capturedAt`). */
  readonly snapshot?: unknown;
  /** The as-of date: the collection's reference date. */
  readonly asOf?: unknown;
}

/**
 * The event's `DTSTAMP` day: the record's own `updated`, else the snapshot date, else the as-of date. A value that is
 * not a date is skipped. `undefined` when none is, so the caller reports it instead of falling back to the clock.
 */
export function stampOf(sources: StampSources): string | undefined {
  return dayOf(sources.updated) ?? dayOf(sources.snapshot) ?? dayOf(sources.asOf);
}

/** What a calendar app can show of an event, and so what a revision is about. */
export interface EventState {
  readonly start: string;
  readonly end?: string;
  readonly title: string;
  /** The number the state was recorded with. Default 0. */
  readonly sequence?: number;
}

/**
 * The event's `SEQUENCE`: the recorded number, raised by one only when the date or the title differs from the recorded
 * state. No recorded state gives 0, and an unchanged event keeps its number however often it is built.
 */
export function sequenceOf(previous: EventState | undefined, current: Omit<EventState, "sequence">): number {
  if (previous === undefined) return 0;
  const base = previous.sequence ?? 0;
  const changed =
    previous.start !== current.start || (previous.end ?? previous.start) !== (current.end ?? current.start) || previous.title !== current.title;
  return changed ? base + 1 : base;
}
