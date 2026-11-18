/**
 * `urls.json`: for every collection, each record id and the URL of its page, so an external tool can link to a record
 * without knowing the site's URL pattern. The site's own address is added when `url` is set in the config, and a site
 * without one writes paths instead, as canonical links and the sitemap do.
 *
 * The file carries the engine version and one hash of the data it maps, so a reader can tell a stale file from a fresh
 * one. It is canonical JSON with sorted keys and one trailing line feed, and it only ever gains fields: a field it has
 * today keeps its meaning. Removed records and redirects are not here; only pages the build wrote.
 *
 * Only the default language's page names a record here: the map is one URL per id, not one per page.
 */
import { createHash } from "node:crypto";
import { version } from "../index.ts";
import type { Page, Site } from "../contracts/content.ts";
import type { Output, OutputFile } from "../contracts/output.ts";
import { canonicalJson } from "../data/lock.ts";

/** The file's name, relative to the output folder. */
const FILE = "urls.json";

/** The origin absolute URLs start with, from `url` in the site config; `undefined` when it is absent or not a URL. */
function originOf(site: Site): string | undefined {
  const value = site.config.url?.trim() ?? "";
  if (value === "") return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

/** One page per record: the default language's page names the record's URL. */
function mainPages(pages: readonly Page[], defaultLang: string): readonly Page[] {
  const chosen = new Map<string, Page>();
  for (const page of pages) {
    if (page.record === undefined || page.record.view !== undefined) continue;
    const key = `${page.record.collection}\u0000${page.record.id}`;
    const current = chosen.get(key);
    if (current === undefined || (page.lang === defaultLang && current.lang !== defaultLang)) chosen.set(key, page);
  }
  return [...chosen.values()];
}

/**
 * The hash of the data a build read: every record id and field, in a stable order. `urls.json` writes it, and a
 * preview's manifest repeats it, so a reader can match the build to the data it mapped.
 */
export function dataHash(site: Site): string {
  const collections: Record<string, readonly unknown[]> = {};
  for (const name of Object.keys(site.collections).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    collections[name] = [...site.collections[name]!.records]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((record) => ({ id: record.id, fields: record.fields }));
  }
  return createHash("sha256").update(canonicalJson(collections)).digest("hex");
}

export const urls: Output = {
  name: "urls",
  async run(site: Site): Promise<readonly OutputFile[]> {
    const pages = mainPages(site.pages, site.config.lang);
    if (pages.length === 0) return [];

    const origin = originOf(site);
    const collections: Record<string, Record<string, string>> = {};
    for (const page of [...pages].sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0))) {
      const record = page.record!;
      const byId = (collections[record.collection] ??= {});
      byId[record.id] = origin === undefined ? page.url : `${origin}${page.url}`;
    }

    const document = {
      version: 1,
      engine: version,
      data: dataHash(site),
      collections,
    };
    return [{ path: FILE, contents: `${canonicalJson(document)}\n` }];
  },
};
