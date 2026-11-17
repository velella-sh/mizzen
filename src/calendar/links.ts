/**
 * Which calendar files a page belongs to, shared by the head's `alternate` links, the record props, and `llms.txt` so
 * they never disagree with the `calendars` output about whether a file exists.
 *
 * A record page belongs to a calendar when its record has events in it. Every other page, and a record page of a
 * collection with no calendar, belongs to none.
 */
import type { CalendarLink, Page, Site } from "../contracts/index.ts";
import type { LinkTag } from "../contracts/render.ts";
import { originOf } from "../feeds/model.ts";
import { calendarEvents } from "./build.ts";

/** A calendar file the build writes. */
export interface WrittenCalendar {
  readonly name: string;
  readonly title: string;
  /** Path of the file, relative to the output folder. */
  readonly file: string;
  readonly events: number;
  /** The records that have an event in it, as `collection NUL id` keys' ids. */
  readonly records: ReadonlySet<string>;
  readonly collection: string;
}

const cache = new WeakMap<Site, readonly WrittenCalendar[]>();

/** The calendars a build writes, in config order. Empty when the output is off or the site has no valid `url`. */
export function writtenCalendars(site: Site): readonly WrittenCalendar[] {
  const cached = cache.get(site);
  if (cached !== undefined) return cached;
  const written: WrittenCalendar[] = [];
  const origin = originOf(site.config.url);
  if (origin !== undefined && site.config.outputs["calendars"] !== false) {
    for (const [name, calendar] of Object.entries(site.config.calendars ?? {})) {
      const { events } = calendarEvents(site, name, calendar, origin);
      if (events.length === 0) continue;
      written.push({
        name,
        title: `${site.config.title}: ${name}`,
        file: `calendars/${name}.ics`,
        events: events.length,
        records: new Set(events.map((e) => e.record)),
        collection: calendar.collection,
      });
    }
  }
  cache.set(site, written);
  return written;
}

/** The calendars a page belongs to, as subscribe links; empty for any page that is not a record in one. */
export function calendarLinksOf(site: Site, page: Page): readonly CalendarLink[] {
  const identity = page.record;
  const origin = originOf(site.config.url);
  if (identity === undefined || identity.view !== undefined || origin === undefined) return [];
  const base = site.config.base.replace(/\/+$/, "");
  return writtenCalendars(site)
    .filter((c) => c.collection === identity.collection && c.records.has(identity.id))
    .map((c) => {
      const url = `${origin}${base}/${c.file}`;
      return { name: c.name, title: c.title, url, webcal: url.replace(/^https?:/, "webcal:") };
    });
}

/** The `alternate` head links of a page's calendars. */
export function calendarHeadLinks(site: Site, page: Page): LinkTag[] {
  return calendarLinksOf(site, page).map((c) => ({
    rel: "alternate",
    href: c.url,
    attrs: { type: "text/calendar", title: c.title },
  }));
}
