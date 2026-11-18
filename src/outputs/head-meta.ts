import type { Page, Site } from "../contracts/content.ts";
import type { Trail } from "../contracts/nav.ts";
import type { Head, LinkTag, MetaTag } from "../contracts/render.ts";
import { analyticsScripts } from "../analytics/script.ts";
import { verificationMeta } from "./verification.ts";
import { calendarHeadLinks } from "../calendar/links.ts";
import { feedLinks } from "../feeds/links.ts";
import { jsonLdFromMapping } from "../data/json-ld.ts";
import { isLaterListPage, isNoindex, mainRecordOf, seoConfigOf } from "../data/seo.ts";
import { SOCIAL_IMAGE_SIZE, socialImagePath } from "../social/image-path.ts";

/**
 * Computes each page's {@link Head} once, so layouts only print it. This unit writes no file: the render step calls
 * {@link headMeta} for every page and hands the result to the layout.
 *
 * Rules (front matter keys from `schema/front-matter/base.schema.json`):
 * - `canonical_url` from front matter wins over the page's own URL; a canonical needs `config.url`, so without it
 *   there is no canonical link. A preview build (`Site.preview`) points every page without one at `canonicalBase` and
 *   the page's own URL, and marks every page `noindex`.
 * - `description` from front matter wins; the home page falls back to the site `description`.
 * - `image` from front matter is the social image; it needs `config.url` to become absolute. Without one, a site that
 *   sets `social.template` gets the generated image of the `social-images` output (see `src/social/image-path.ts`).
 * - A record page's canonical may come from the collection's `seo.canonical` field; front matter still wins. Page two
 *   onwards of a list always has its own URL as canonical, even when the list's front matter names one.
 * - `noindex` (`seo.noindex` field of a record, or `noindex_pagination: true` on a list) writes `robots: noindex`.
 * - `og: false` drops the Open Graph and Twitter card tags and the image in the structured data; the canonical link
 *   and the description stay.
 * - A collection's `seo.jsonLd` mapping adds one object to each of its record pages (see `src/data/json-ld.ts`). A list
 *   page adds an `ItemList` of the records on that page, and a record or list page adds a `BreadcrumbList`; the
 *   collection's `seo.itemList` and `seo.breadcrumbs` set to `false` turn each off.
 * - Structured data: the home page is a `WebSite`, every other page a `TechArticle` (publisher: the site title), and a
 *   page with a breadcrumb trail adds a `BreadcrumbList`.
 */

/** The separator between a page's title and the site title in the document title. */
const TITLE_SEPARATOR = " | ";

/** Returns the value when it is a string with text in it, else `undefined`. */
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * Makes a URL absolute: an `http(s)` URL is kept, and a path starting with `/` gets the site `url` in front. Anything
 * else, or a path with no site `url` to use, has no absolute form and returns `undefined`.
 */
function absolute(site: Site, value: string): string | undefined {
  if (/^https?:\/\//i.test(value)) return value;
  const origin = site.config.url?.replace(/\/$/, "");
  if (origin === undefined || origin === "" || !value.startsWith("/")) return undefined;
  return `${origin}${value}`;
}

/** True for the home page, whose URL is the site `base` followed by a slash. */
function isHome(site: Site, page: Page): boolean {
  return page.url === `${site.config.base}/`;
}

/** The breadcrumb as a schema.org `BreadcrumbList`, one `ListItem` per link of the trail, in order. */
function breadcrumbList(site: Site, trail: Trail): Readonly<Record<string, unknown>> {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: trail.map((link, index) => {
      const item = absolute(site, link.url);
      return {
        "@type": "ListItem",
        position: index + 1,
        name: link.title,
        ...(item === undefined ? {} : { item }),
      };
    }),
  };
}

/** The `ItemList` of a list page: one `ListItem` per record on this page, never more, with the record's URL. */
function itemList(site: Site, page: Page): Readonly<Record<string, unknown>> | undefined {
  const list = page.list;
  if (list === undefined) return undefined;
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const record of [...list.records, ...list.groups.flatMap((group) => group.records)]) {
    if (seen.has(record.url)) continue;
    seen.add(record.url);
    urls.push(record.url);
  }
  if (urls.length === 0) return undefined;
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: urls.map((url, index) => ({ "@type": "ListItem", position: index + 1, url: absolute(site, url) ?? url })),
  };
}

/**
 * The canonical a page declares. `canonical_url` front matter wins, then a preview's `canonicalBase`, then the
 * collection's `seo.canonical` field, then the page's own URL. Page two onwards of a list is its own page, so it never
 * takes the canonical its first page's front matter names.
 */
export function canonicalOf(site: Site, page: Page): string | undefined {
  const later = isLaterListPage(page);
  const named = later ? undefined : text(page.frontMatter.canonical_url);
  if (named !== undefined) return absolute(site, named);
  const preview = site.preview;
  if (preview !== undefined) {
    const base = preview.canonicalBase.replace(/\/+$/, "");
    if (/^https?:\/\//i.test(base)) return `${base}${page.url}`;
  }
  const field = later ? undefined : seoConfigOf(site, page)?.canonical;
  const record =
    field === undefined || text(site.config.url) === undefined ? undefined : text(mainRecordOf(site, page)?.fields[field]);
  return record === undefined ? absolute(site, page.url) : absolute(site, record);
}

/**
 * Computes the `<head>` of one page: the document title, its meta and link tags, and its JSON-LD objects.
 *
 * @param site The whole site model, for the site title, base, URL, and description.
 * @param page The page the head is for.
 * @param trail The page's breadcrumb from the navigation, the page itself last; empty when the page is not listed.
 */
export function headMeta(site: Site, page: Page, trail: Trail): Head {
  const home = isHome(site, page);
  const siteTitle = site.config.title;
  const pageName = home ? siteTitle : page.title;
  const title = home ? siteTitle : `${page.title}${TITLE_SEPARATOR}${siteTitle}`;

  const description = text(page.frontMatter.description) ?? (home ? text(site.config.description) : undefined);
  const canonical = canonicalOf(site, page);
  const social = page.frontMatter.og !== false;

  const ownImage = text(page.frontMatter.image);
  const imageValue = ownImage ?? socialImagePath(site, page);
  const image = social && imageValue !== undefined ? absolute(site, imageValue) : undefined;

  const meta: MetaTag[] = [];
  if (description !== undefined) meta.push({ name: "description", content: description });
  if (social) {
    meta.push({ name: "og:type", content: home ? "website" : "article", property: true });
    meta.push({ name: "og:title", content: pageName, property: true });
    if (description !== undefined) meta.push({ name: "og:description", content: description, property: true });
    if (canonical !== undefined) meta.push({ name: "og:url", content: canonical, property: true });
    meta.push({ name: "og:site_name", content: siteTitle, property: true });
    if (image !== undefined) meta.push({ name: "og:image", content: image, property: true });
    if (image !== undefined && ownImage === undefined) {
      meta.push({ name: "og:image:width", content: String(SOCIAL_IMAGE_SIZE.width), property: true });
      meta.push({ name: "og:image:height", content: String(SOCIAL_IMAGE_SIZE.height), property: true });
    }
    meta.push({ name: "twitter:card", content: image === undefined ? "summary" : "summary_large_image" });
  }

  if (site.preview !== undefined || isNoindex(site, page)) meta.push({ name: "robots", content: "noindex" });
  meta.push(...verificationMeta(site, page));

  const links: LinkTag[] = canonical === undefined ? [] : [{ rel: "canonical", href: canonical }];
  links.push(...feedLinks(site, page));
  links.push(...calendarHeadLinks(site, page));

  const structured: Record<string, unknown> = {
    "@context": "https://schema.org",
    inLanguage: page.lang,
    ...(description === undefined ? {} : { description }),
    ...(canonical === undefined ? {} : { url: canonical }),
    ...(image === undefined ? {} : { image }),
  };
  const jsonLd: Readonly<Record<string, unknown>>[] = home
    ? [{ ...structured, "@type": "WebSite", name: siteTitle }]
    : [
        {
          ...structured,
          "@type": "TechArticle",
          headline: pageName,
          publisher: { "@type": "Organization", name: siteTitle },
        },
      ];
  const seo = seoConfigOf(site, page);
  if (trail.length > 0 && seo?.breadcrumbs !== false) jsonLd.push(breadcrumbList(site, trail));
  if (seo?.itemList !== false) {
    const items = itemList(site, page);
    if (items !== undefined) jsonLd.push(items);
  }
  if (seo?.jsonLd !== undefined) {
    const record = mainRecordOf(site, page);
    const own = record === undefined ? undefined : jsonLdFromMapping(seo.jsonLd, record.fields);
    if (own !== undefined) jsonLd.push(own);
  }

  return { title, meta, links, jsonLd, scripts: analyticsScripts(site, page) };
}
