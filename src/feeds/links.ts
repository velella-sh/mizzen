/**
 * The `alternate` links a page advertises for the feeds of its collection.
 *
 * A record page and a list page belong to one collection, so they advertise that collection's feeds; every other page
 * advertises none. A feed is advertised only when a build writes its file, so the address is always absolute.
 */
import type { Page, Site } from "../contracts/index.ts";
import type { LinkTag } from "../contracts/render.ts";
import { feedIsWritten } from "./entries.ts";
import { feedFile, FEED_MEDIA_TYPE } from "./files.ts";
import { originOf } from "./model.ts";

/** The feed links for one page, in the config's feed order and then the config's format order. */
export function feedLinks(site: Site, page: Page): LinkTag[] {
  const collection = page.record?.collection ?? page.list?.collection;
  if (collection === undefined) return [];
  const origin = originOf(site.config.url);
  if (origin === undefined) return [];
  const base = site.config.base.replace(/\/+$/, "");
  const links: LinkTag[] = [];
  const changelog = page.list?.feed;
  if (changelog !== undefined) {
    links.push({ rel: "alternate", href: changelog, attrs: { type: FEED_MEDIA_TYPE.atom, title: page.title } });
  }
  for (const [name, feed] of Object.entries(site.config.feeds)) {
    if (feed.collection !== collection || !feedIsWritten(site, name)) continue;
    for (const format of feed.formats ?? ["atom"]) {
      const file = `${base}/${feedFile(name, format)}`;
      links.push({
        rel: "alternate",
        href: `${origin}${file}`,
        attrs: { type: FEED_MEDIA_TYPE[format], title: feed.title ?? site.config.title },
      });
    }
  }
  return links;
}
