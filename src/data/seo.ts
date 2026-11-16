/**
 * What a record or list page's SEO settings say, shared by the head and the sitemap so the two never disagree.
 *
 * The settings live under `collections.<name>.seo` in the config; a record page reads its collection's, and a list page
 * reads the collection it lists. A page of an ordinary file reads none and every function here returns its default.
 */
import type { CollectionSeoConfig } from "../contracts/config.ts";
import type { Page, RecordProps, Site } from "../contracts/index.ts";
import { recordPropsOf } from "./record-context.ts";

/** The `seo` settings of the collection a record or list page belongs to; `undefined` for any other page. */
export function seoConfigOf(site: Site, page: Page): CollectionSeoConfig | undefined {
  const name = page.record?.collection ?? page.list?.collection;
  return name === undefined ? undefined : site.config.collections[name]?.seo;
}

/** The record of a main record page with its fields in the page's language; `undefined` for a view and any other page. */
export function mainRecordOf(site: Site, page: Page): RecordProps | undefined {
  if (page.record === undefined || page.record.view !== undefined) return undefined;
  return recordPropsOf(site, page);
}

/** True for a value that reads as "yes": `true`, `1`, or the text `true`, `yes`, `1`, `y`, in any case. */
export function truthy(value: unknown): boolean {
  if (value === true || value === 1) return true;
  return typeof value === "string" && ["true", "yes", "y", "1"].includes(value.trim().toLowerCase());
}

/** True for page two onwards of a list. */
export function isLaterListPage(page: Page): boolean {
  return page.list !== undefined && page.list.pagination.page > 1;
}

/**
 * True when the page is for readers only: a record the collection's `seo.noindex` field marks, or page two onwards of a
 * list whose front matter sets `noindex_pagination: true`. The page is still built and linked; it is not for search
 * engines, so its head says `noindex` and the sitemap leaves it out.
 */
export function isNoindex(site: Site, page: Page): boolean {
  if (isLaterListPage(page) && page.frontMatter.noindex_pagination === true) return true;
  const field = seoConfigOf(site, page)?.noindex;
  if (field === undefined) return false;
  const record = mainRecordOf(site, page);
  return record !== undefined && truthy(record.fields[field]);
}
