/**
 * The `alternate` links a page advertises for the feeds of its collection.
 *
 * A record page and a list page belong to one collection, so they advertise that collection's feeds; every other page
 * advertises none. The address is absolute when the site has a `url` and carries `base` either way.
 */
import type { Page, Site } from "../contracts/index.ts";
import type { LinkTag } from "../contracts/render.ts";
import { feedFile, FEED_MEDIA_TYPE } from "./files.ts";

/** The feed links for one page, in the config's feed order and then the config's format order. */
export function feedLinks(site: Site, page: Page): LinkTag[] {
  const collection = page.record?.collection ?? page.list?.collection;
  if (collection === undefined) return [];
  const origin = site.config.url?.replace(/\/+$/, "");
  const base = site.config.base.replace(/\/+$/, "");
  const links: LinkTag[] = [];
  for (const [name, feed] of Object.entries(site.config.feeds)) {
    if (feed.collection !== collection) continue;
    for (const format of feed.formats ?? ["atom"]) {
      const file = `${base}/${feedFile(name, format)}`;
      links.push({
        rel: "alternate",
        href: origin === undefined ? file : `${origin}${file}`,
        attrs: { type: FEED_MEDIA_TYPE[format], title: feed.title ?? site.config.title },
      });
    }
  }
  return links;
}
