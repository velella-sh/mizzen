/**
 * One feed, independent of its file format: what every writer needs, and nothing a writer computes.
 *
 * A feed is built once from the site model, then written as Atom, RSS 2.0, or JSON Feed. Entries are already ordered
 * newest first with their final ids, links, and dates, so every format describes the same feed.
 */

/** One entry of a feed. */
export interface FeedEntry {
  /** The entry's permanent id: a tag URI that survives a URL change. */
  readonly id: string;
  readonly title: string;
  /** Absolute URL of the page the entry is about. */
  readonly link: string;
  readonly date: Date;
  /** Plain-text summary, when the record has one. */
  readonly summary?: string;
  /** Named record fields for the JSON Feed extension key; absent when the feed publishes none. */
  readonly fields?: Readonly<Record<string, unknown>>;
}

/** A feed ready to be written. */
export interface FeedModel {
  /** The feed's id. The existing feeds use their own URL; a collection feed uses a tag URI. */
  readonly id: string;
  readonly title: string;
  /** Absolute URL of the feed file itself. */
  readonly self: string;
  /** Absolute URL of the page the feed describes. */
  readonly home?: string;
  readonly description?: string;
  readonly language: string;
  /** Author name, when the feed has one. */
  readonly author?: string;
  /** Entries, newest first; never empty, because a feed without an entry has no date to publish. */
  readonly entries: readonly FeedEntry[];
}

/** Escapes the five characters XML reserves, so any title or URL can sit inside an element or an attribute. */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** The scheme and host absolute URLs start with, from `url` in the site config; `undefined` when it is missing or not absolute. */
export function originOf(url: string | undefined): string | undefined {
  const value = url?.trim() ?? "";
  if (value === "") return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

/** A date as an RFC 822 timestamp in UTC, which RSS 2.0 asks for. */
export function rfc822(date: Date): string {
  return date.toUTCString();
}
