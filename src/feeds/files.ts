/** Where a feed's format is written and the media type it is served as. */
import type { FeedFormat } from "../contracts/index.ts";

/** The file an entry's format is written to, relative to the output folder. */
export function feedFile(name: string, format: FeedFormat): string {
  if (format === "rss") return `feeds/${name}.rss.xml`;
  if (format === "json") return `feeds/${name}.json`;
  return `feeds/${name}.xml`;
}

/** The media type of each feed format, for a head's alternate link. */
export const FEED_MEDIA_TYPE: Readonly<Record<FeedFormat, string>> = {
  atom: "application/atom+xml",
  rss: "application/rss+xml",
  json: "application/feed+json",
};
