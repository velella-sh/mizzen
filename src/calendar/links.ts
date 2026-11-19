/**
 * Which calendar files a page belongs to, shared by the head's `alternate` links, the record props, and `llms.txt` so
 * they never disagree with the `calendars` output about whether a file exists.
 *
 * Record pages get the calendars they have events in. List pages get their collection's calendars and links for
 * groups on the same field.
 */
import type { CalendarLink, ListProps, Page, Site } from "../contracts/index.ts";
import type { LinkTag } from "../contracts/render.ts";
import { parseGroup } from "../data/group.ts";
import { originOf } from "../feeds/model.ts";
import { calendarEvents, calendarGroups } from "./build.ts";

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
  readonly groupBy?: string;
  readonly groups: ReadonlyMap<string, string>;
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
        ...(calendar.groupBy === undefined ? {} : { groupBy: calendar.groupBy }),
        groups: new Map(calendarGroups(name, events).map(({ value, file }) => [value, file])),
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
  return writtenCalendars(site)
    .filter((c) => c.collection === identity.collection && c.records.has(identity.id))
    .map((c) => subscription(origin, site.config.base, c.name, c.title, c.file));
}

function subscription(origin: string, base: string, name: string, title: string, file: string): CalendarLink {
  const url = `${origin}${base.replace(/\/+$/, "")}/${file}`;
  return { name, title, url, webcal: url.replace(/^https?:/, "webcal:") };
}

/** Fill the list and its value groups with links to the files that are actually published. */
export function listCalendarsOf(site: Site, page: Page): ListProps | undefined {
  const list = page.list;
  const origin = originOf(site.config.url);
  if (list === undefined || origin === undefined) return list;
  const calendars = writtenCalendars(site).filter((c) => c.collection === list.collection);
  if (calendars.length === 0) return list;

  const spec = page.frontMatter["list"] as { group?: unknown; expand?: { field?: string } } | undefined;
  const grouping = parseGroup(spec?.group, undefined).spec;
  const field = list.groups[0]?.url !== undefined ? spec?.expand?.field : grouping?.by === "value" ? grouping.field : undefined;
  const link = (c: WrittenCalendar) => subscription(origin, site.config.base, c.name, c.title, c.file);
  return {
    ...list,
    calendars: calendars.map(link),
    groups: field === undefined ? list.groups : list.groups.map((group) => {
      const value = group.key.trim();
      const links = calendars.flatMap((c) => {
        const file = c.groupBy === field ? c.groups.get(value) : undefined;
        return file === undefined ? [] : [subscription(origin, site.config.base, c.name, `${c.title} (${value})`, file)];
      });
      return links.length === 0 ? group : { ...group, calendars: links };
    }),
  };
}

/** The `alternate` head links of a page's calendars. */
export function calendarHeadLinks(site: Site, page: Page): LinkTag[] {
  return calendarLinksOf(site, page).map((c) => ({
    rel: "alternate",
    href: c.url,
    attrs: { type: "text/calendar", title: c.title },
  }));
}
