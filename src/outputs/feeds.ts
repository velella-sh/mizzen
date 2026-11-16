/**
 * The `feeds` output: one Atom, RSS 2.0, or JSON Feed file per feed the site config declares.
 *
 * A feed lists a collection's records through the same `where` a list page uses, ordered by its date field, newest
 * first, and cut to `limit` (default 50). A record without a valid date or without a main page is left out. The feed's
 * `updated` date is its newest entry's date, never the clock, so two builds of the same data write the same bytes.
 *
 * Every link is absolute, because a feed reader has no page to resolve a relative one against: a site with feeds but no
 * valid `url` writes none and reports it once. A feed with no entry writes no file, since Atom has no date to publish.
 */
import type { FeedConfig, Site } from "../contracts/index.ts";
import type { Output, OutputContext, OutputFile } from "../contracts/output.ts";
import { filterRows, instantOf, parseQuery, type Row } from "../data/query.ts";
import { localizeFields, resolveIn, scalarText } from "../data/record-context.ts";
import { referenceDateOf } from "../data/reference-date.ts";
import { atomFeed } from "../feeds/atom.ts";
import { feedFile } from "../feeds/files.ts";
import { entryId } from "../feeds/id.ts";
import { jsonFeed } from "../feeds/json-feed.ts";
import { originOf, type FeedEntry } from "../feeds/model.ts";
import { rssFeed } from "../feeds/rss.ts";
import { indexRecords } from "./search-shared.ts";

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
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
function entriesOf(site: Site, feed: FeedConfig, origin: string, ctx: OutputContext): readonly FeedEntry[] {
  const collection = site.collections[feed.collection];
  // The config loader reports a feed that names a collection the site does not declare; there is nothing to list here.
  if (collection === undefined) return [];

  const reference = referenceDateOf(feed.collection, site.config.collections[feed.collection], site.data);
  if (reference.error !== undefined) {
    ctx.report({ id: "feeds.reference-date", severity: "error", message: reference.error });
  }
  // A feed's `where` is the list syntax, so the one parser keeps the two in step; its messages say "list".
  const query = parseQuery(feed.where, undefined, {
    file: "mizzen.yml",
    collection: feed.collection,
    ...(reference.date === undefined ? {} : { reference: reference.date }),
  });
  for (const diagnostic of query.diagnostics) ctx.report(diagnostic);

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

/** Writes the declared feeds, sorted by path. */
export const feeds: Output = {
  name: "feeds",
  async run(site: Site, ctx: OutputContext): Promise<readonly OutputFile[]> {
    const names = Object.keys(site.config.feeds);
    if (names.length === 0) return [];

    const origin = originOf(site.config.url);
    if (origin === undefined) {
      ctx.report({
        id: "feeds.no-url",
        severity: "warning",
        message: "The site declares feeds, but has no valid `url`, so no feed can carry absolute links.",
        help: "Set `url: https://example.com` in the site config.",
      });
      return [];
    }

    const base = site.config.base.replace(/\/+$/, "");
    const home = `${origin}${base}/`;
    const files: OutputFile[] = [];
    for (const name of names) {
      const feed = site.config.feeds[name]!;
      const entries = entriesOf(site, feed, origin, ctx);
      if (entries.length === 0) continue;

      const title = feed.title ?? site.config.title;
      const id = entryId(origin, "feeds", name);
      for (const format of feed.formats ?? ["atom"]) {
        const self = `${origin}${base}/${feedFile(name, format)}`;
        const model = {
          id,
          title,
          self,
          home,
          language: site.config.lang,
          ...(site.config.description === undefined ? {} : { description: site.config.description }),
          entries,
        };
        files.push({
          path: feedFile(name, format),
          contents: format === "rss" ? rssFeed(model) : format === "json" ? jsonFeed(model) : atomFeed(model),
        });
      }
    }

    return files.sort((a, b) => byCodePoint(a.path, b.path));
  },
};
