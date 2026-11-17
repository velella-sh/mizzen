/**
 * A feed's window: the entries dated from the as-of date to that date plus `days`, both included, so a feed can list
 * what ends soon without reading the clock.
 *
 * The window starts at the resolved as-of date: the config's `asOf` (the `--as-of` flag reaches the build through it),
 * then the collection's `referenceDate`. An entry id is the calendar event's `UID` when a calendar reads the feed's date
 * field, so the same event is the same id in the feed and in the `.ics` file.
 */
import { eventUid } from "../calendar/uid.ts";
import type { FeedConfig, Site } from "../contracts/index.ts";
import type { Diagnostic } from "../contracts/diagnostic.ts";
import { missingAsOf } from "../dates/as-of.ts";
import { shiftDate } from "../data/query.ts";
import { entryId } from "./id.ts";

/** The first and last day of a window, both included. */
export interface FeedWindow {
  /** `YYYY-MM-DD`. */
  readonly from: string;
  /** `YYYY-MM-DD`. */
  readonly to: string;
}

/** A feed's window, or the diagnostic that says why it has none. */
export interface FeedWindowResult {
  readonly window?: FeedWindow;
  readonly error?: Diagnostic;
}

/** The window `feed.window` asks for, starting at the as-of date; an error when no as-of date is set. */
export function feedWindow(site: Site, feed: FeedConfig, reference: string | undefined): FeedWindowResult {
  const days = feed.window?.days;
  if (days === undefined) return {};
  const from = site.config.asOf ?? reference;
  if (from === undefined) return { error: missingAsOf("A feed window") };
  return { window: { from, to: shiftDate(from, days, "d")! } };
}

/** Whether an entry dated `date` falls in `window`; a partial date counts from its first day. */
export function inWindow(date: Date, window: FeedWindow): boolean {
  const day = date.toISOString().slice(0, 10);
  return day >= window.from && day <= window.to;
}

/** The calendar event name that reads `field`, from a calendar of the feed's collection; `undefined` when none does. */
function eventNameOf(site: Site, feed: FeedConfig): string | undefined {
  for (const calendar of Object.values(site.config.calendars ?? {})) {
    if (calendar.collection !== feed.collection) continue;
    for (const event of calendar.events) if (event.field === feed.date) return event.name;
  }
  return undefined;
}

/** A windowed entry's id: the calendar event's `UID`, or the ordinary feed id when no calendar declares that event. */
export function windowEntryId(site: Site, feed: FeedConfig, origin: string, record: string): string {
  const event = eventNameOf(site, feed);
  if (event === undefined) return entryId(origin, feed.collection, record);
  return eventUid({ origin, collection: feed.collection, record, event });
}
