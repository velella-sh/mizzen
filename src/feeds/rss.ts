/**
 * The RSS 2.0 writer: the same feed as Atom, for readers that only speak RSS.
 *
 * Dates are RFC 822 in UTC, and the entry's tag URI is a permanent `guid` that is not a URL. No vendor namespace is
 * added; a summary is plain text escaped into `description`, because the engine holds no HTML for it.
 */
import { escapeXml, rfc822, type FeedModel } from "./model.ts";

/** Writes a feed as an RSS 2.0 document. */
export function rssFeed(model: FeedModel): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0">',
    "  <channel>",
    `    <title>${escapeXml(model.title)}</title>`,
    ...(model.home === undefined ? [] : [`    <link>${escapeXml(model.home)}</link>`]),
    `    <description>${escapeXml(model.description ?? model.title)}</description>`,
    `    <language>${escapeXml(model.language)}</language>`,
    `    <lastBuildDate>${rfc822(model.entries[0]!.date)}</lastBuildDate>`,
    ...model.entries.flatMap((entry) => [
      "    <item>",
      `      <title>${escapeXml(entry.title)}</title>`,
      `      <link>${escapeXml(entry.link)}</link>`,
      `      <guid isPermaLink="false">${escapeXml(entry.id)}</guid>`,
      `      <pubDate>${rfc822(entry.date)}</pubDate>`,
      ...(entry.summary === undefined ? [] : [`      <description>${escapeXml(entry.summary)}</description>`]),
      "    </item>",
    ]),
    "  </channel>",
    "</rss>",
    "",
  ].join("\n");
}
