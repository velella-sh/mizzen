/**
 * The Atom 1.0 writer: the format every 0.2.0 feed already publishes.
 *
 * The bytes are the ones `changes.xml` and `changelog.xml` had before the shared model, so generalizing the writer
 * changed no published file. Entry ids and links are written as the model holds them; the model decides whether they
 * are absolute.
 */
import { escapeXml, type FeedEntry, type FeedModel } from "./model.ts";

/** One `<entry>` block, indented like the feed. */
function entryXml(entry: FeedEntry): string[] {
  return [
    "  <entry>",
    `    <title>${escapeXml(entry.title)}</title>`,
    `    <link href="${escapeXml(entry.link)}" rel="alternate" type="text/html"/>`,
    `    <id>${escapeXml(entry.id)}</id>`,
    `    <updated>${entry.date.toISOString()}</updated>`,
    ...(entry.summary === undefined ? [] : [`    <summary>${escapeXml(entry.summary)}</summary>`]),
    "  </entry>",
  ];
}

/** Writes a feed as an Atom 1.0 document. */
export function atomFeed(model: FeedModel): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="${escapeXml(model.language)}">`,
    `  <title>${escapeXml(model.title)}</title>`,
    `  <link href="${escapeXml(model.self)}" rel="self" type="application/atom+xml"/>`,
    ...(model.home === undefined ? [] : [`  <link href="${escapeXml(model.home)}" rel="alternate" type="text/html"/>`]),
    `  <id>${escapeXml(model.id)}</id>`,
    `  <updated>${model.entries[0]!.date.toISOString()}</updated>`,
    ...(model.author === undefined ? [] : ["  <author>", `    <name>${escapeXml(model.author)}</name>`, "  </author>"]),
    ...model.entries.flatMap(entryXml),
    "</feed>",
    "",
  ].join("\n");
}
