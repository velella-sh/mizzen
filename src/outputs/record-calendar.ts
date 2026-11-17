/**
 * The `record-calendar` output: one add-to-calendar `.ics` file beside each record page, holding that record's events
 * only, taken from every calendar of its collection.
 *
 * The address of the file is handed to the theme as `record.calendar`. A record with no events, a collection with no
 * calendar, and a site with no valid `url` get no file and no address.
 */
import { calendarLinksOf } from "../calendar/links.ts";
import { calendarEvents } from "../calendar/build.ts";
import { writeIcs, type IcsEvent } from "../calendar/ics.ts";
import type { Page, RecordProps, Site } from "../contracts/index.ts";
import { recordPropsOf } from "../data/record-context.ts";
import type { Output, OutputContext, OutputFile } from "../contracts/output.ts";
import { originOf } from "../feeds/model.ts";
import { indexRecords } from "./search-shared.ts";

const cache = new WeakMap<Site, ReadonlyMap<string, readonly IcsEvent[]>>();

/** Every record's events across the site's calendars, keyed by `collection NUL id`, in date order, each id once. */
function eventsByRecord(site: Site): ReadonlyMap<string, readonly IcsEvent[]> {
  const cached = cache.get(site);
  if (cached !== undefined) return cached;
  const map = new Map<string, IcsEvent[]>();
  const origin = originOf(site.config.url);
  if (origin !== undefined) {
    for (const [name, calendar] of Object.entries(site.config.calendars ?? {})) {
      for (const item of calendarEvents(site, name, calendar, origin).events) {
        const key = `${calendar.collection}\0${item.record}`;
        const list = map.get(key) ?? [];
        if (!list.some((event) => event.uid === item.event.uid)) list.push(item.event);
        map.set(key, list);
      }
    }
    for (const list of map.values()) {
      list.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));
    }
  }
  cache.set(site, map);
  return map;
}

/** Where a record page's calendar file lives, relative to the site root with `base` removed and no leading slash. */
function filePathOf(site: Site, url: string): string {
  const base = site.config.base.replace(/\/+$/, "");
  const path = (base !== "" && url.startsWith(base) ? url.slice(base.length) : url).replace(/^\/+/, "");
  if (path === "" || path.endsWith("/")) return `${path}calendar.ics`;
  return `${path.replace(/\.html?$/, "")}.ics`;
}

/** The URL of the record page's calendar file, or `undefined` when the page is not a main record page or has no events. */
export function recordCalendarUrl(site: Site, page: Page): string | undefined {
  if (site.config.outputs["record-calendar"] === false) return undefined;
  const identity = page.record;
  if (identity === undefined || identity.view !== undefined) return undefined;
  const key = `${identity.collection}\0${identity.id}`;
  const events = eventsByRecord(site).get(key);
  if (events === undefined || events.length === 0 || mainUrls(site).get(key) !== page.url) return undefined;
  const base = site.config.base.replace(/\/+$/, "");
  return `${base}/${filePathOf(site, page.url)}`;
}

const mains = new WeakMap<Site, ReadonlyMap<string, string>>();

/** The URL of each record's main page (the one `indexRecords` picks), keyed like {@link eventsByRecord}. */
function mainUrls(site: Site): ReadonlyMap<string, string> {
  const cached = mains.get(site);
  if (cached !== undefined) return cached;
  const map = new Map<string, string>();
  for (const collection of Object.keys(site.config.calendars ?? {}).length === 0 ? [] : Object.keys(site.collections)) {
    for (const { record, page } of indexRecords(site, collection)) map.set(`${collection}\0${record.id}`, page.url);
  }
  mains.set(site, map);
  return map;
}

/** Writes one calendar file per record that has events, sorted by path. */
export const recordCalendar: Output = {
  name: "record-calendar",
  async run(site: Site, _ctx: OutputContext): Promise<readonly OutputFile[]> {
    const files: OutputFile[] = [];
    const map = eventsByRecord(site);
    if (map.size === 0 || site.config.outputs["record-calendar"] === false) return files;
    for (const collection of Object.keys(site.collections)) {
      for (const { record, page } of indexRecords(site, collection)) {
        const events = map.get(`${collection}\0${record.id}`);
        if (events === undefined || events.length === 0) continue;
        const title = typeof record.fields["title"] === "string" ? record.fields["title"] : record.id;
        files.push({ path: filePathOf(site, page.url), contents: writeIcs({ name: title, events }) });
      }
    }
    return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  },
};

/** The props a layout receives for a record page, with `calendar` set when the record has a calendar file. */
export function recordPropsWithCalendar(site: Site, page: Page): RecordProps | undefined {
  const record = recordPropsOf(site, page);
  if (record === undefined) return undefined;
  const calendar = recordCalendarUrl(site, page);
  const calendars = calendarLinksOf(site, page);
  return {
    ...record,
    ...(calendar === undefined ? {} : { calendar }),
    ...(calendars.length === 0 ? {} : { calendars }),
  };
}
