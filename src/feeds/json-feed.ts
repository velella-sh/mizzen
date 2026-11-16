/**
 * The JSON Feed 1.1 writer.
 *
 * Keys are written in one fixed order and the file ends with a line feed, so the same feed gives the same bytes. Named
 * record fields are published under the `_mizzen` extension key on the item, never as core JSON Feed keys.
 */
import type { FeedEntry, FeedModel } from "./model.ts";

/** The extension key that carries a feed's selected record fields. */
const EXTENSION = "_mizzen";

/** One item, with its keys in a fixed order. */
function itemOf(entry: FeedEntry): Readonly<Record<string, unknown>> {
  return {
    id: entry.id,
    url: entry.link,
    title: entry.title,
    ...(entry.summary === undefined ? {} : { content_text: entry.summary }),
    date_published: entry.date.toISOString(),
    ...(entry.fields === undefined ? {} : { [EXTENSION]: entry.fields }),
  };
}

/** Writes a feed as a JSON Feed 1.1 document. */
export function jsonFeed(model: FeedModel): string {
  const body = {
    version: "https://jsonfeed.org/version/1.1",
    title: model.title,
    ...(model.home === undefined ? {} : { home_page_url: model.home }),
    feed_url: model.self,
    ...(model.description === undefined ? {} : { description: model.description }),
    language: model.language,
    items: model.entries.map(itemOf),
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}
