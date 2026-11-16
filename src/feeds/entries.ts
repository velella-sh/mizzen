/**
 * The entries one declared feed lists, shared by the `feeds` output and the `alternate` head links so the two never
 * disagree about whether a feed file exists.
 *
 * A feed lists a collection's records through the same `where` a list page uses, ordered by its date field, newest
 * first, and cut to `limit` (default 50). A record without a valid date or without a main page is left out.
 */
import type { FeedConfig, Site } from "../contracts/index.ts";
import type { Diagnostic } from "../contracts/diagnostic.ts";
import { filterRows, instantOf, parseQuery, type Row } from "../data/query.ts";
import { localizeFields, resolveIn, scalarText } from "../data/record-context.ts";
import { referenceDateOf } from "../data/reference-date.ts";
import { indexRecords } from "../outputs/search-shared.ts";
import { entryId } from "./id.ts";
import { originOf, type FeedEntry } from "./model.ts";

/** Compares by code point, never by locale. */
export function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A record field's text, with a parser `Date` read as an ISO instant; `undefined` for a list or an object. */
function textOf(value: unknown): string | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  return scalarText(value);
}

/** One entry's date, from the record's normalized dates or its raw field. */
function dateOf(fields: Readonly<Record<string, unknown>>, dates: Row["dates"], field: string): Date | undefined {
  const normalized = dates?.[field];
  const text = normalized ?? textOf(resolveIn(fields, field).value);
  if (text === undefined) return undefined;
  const instant = instantOf(text);
  return instant === undefined ? undefined : new Date(instant);
}

/** The entries one declared feed lists, newest first, already addressed and identified. */
export function feedEntries(
  site: Site,
  feed: FeedConfig,
  origin: string,
  report: (diagnostic: Diagnostic) => void = () => {},
): readonly FeedEntry[] {
  const collection = site.collections[feed.collection];
  // The config loader reports a feed that names a collection the site does not declare; there is nothing to list here.
  if (collection === undefined) return [];

  const reference = referenceDateOf(feed.collection, site.config.collections[feed.collection], site.data);
  if (reference.error !== undefined) {
    report({ id: "feeds.reference-date", severity: "error", message: reference.error });
  }
  // A feed's `where` is the list syntax, so the one parser keeps the two in step; its messages say "list".
  const query = parseQuery(feed.where, undefined, {
    file: "mizzen.yml",
    collection: feed.collection,
    ...(reference.date === undefined ? {} : { reference: reference.date }),
  });
  for (const diagnostic of query.diagnostics) report(diagnostic);

  const rows = indexRecords(site, feed.collection).map(({ record, page }) => {
    const fields = localizeFields(record.fields, site.config.lang, site.config.lang).fields;
    return {
      id: record.id,
      fields,
      ...(record.normalizedDates === undefined ? {} : { dates: record.normalizedDates }),
      record,
      page,
    };
  });

  const entries: FeedEntry[] = [];
  for (const row of filterRows(rows, query.where)) {
    const date = dateOf(row.fields, row.dates, feed.date);
    if (date === undefined) continue;
    const title = textOf(resolveIn(row.fields, "title").value) ?? row.record.id;
    const summary = textOf(resolveIn(row.fields, "summary").value) ?? textOf(resolveIn(row.fields, "description").value);
    const extra = feed.idField === undefined ? undefined : textOf(resolveIn(row.fields, feed.idField).value);
    const published: Record<string, unknown> = {};
    for (const field of feed.fields ?? []) {
      const found = resolveIn(row.fields, field);
      if (found.found) published[field] = found.value;
    }
    entries.push({
      id: entryId(origin, feed.collection, row.record.id, extra),
      title,
      link: new URL(row.page.url, origin).href,
      date,
      ...(summary === undefined ? {} : { summary }),
      ...(Object.keys(published).length === 0 ? {} : { fields: published }),
    });
  }

  return entries.sort((a, b) => b.date.getTime() - a.date.getTime() || byCodePoint(a.id, b.id)).slice(0, feed.limit ?? 50);
}

const verdicts = new WeakMap<Site, Map<string, boolean>>();

/**
 * Whether a build of this site writes the feed named `name`: the `feeds` output is on, the site has a valid `url`, and
 * at least one entry is eligible. The head links and the output both ask this one question.
 */
export function feedIsWritten(site: Site, name: string): boolean {
  if (site.config.outputs.feeds === false) return false;
  const feed = site.config.feeds[name];
  const origin = originOf(site.config.url);
  if (feed === undefined || origin === undefined) return false;
  let cache = verdicts.get(site);
  if (cache === undefined) verdicts.set(site, (cache = new Map()));
  let verdict = cache.get(name);
  if (verdict === undefined) cache.set(name, (verdict = feedEntries(site, feed, origin).length > 0));
  return verdict;
}
