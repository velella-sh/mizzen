import type { SiteConfig } from "../contracts/config.ts";
import type { Page, Site } from "../contracts/content.ts";
import type { Output, OutputContext, OutputFile } from "../contracts/output.ts";
import { languageGroups, translationId } from "../content/lang-fallback.ts";
import { isFallbackCopy, isNoindex, mainRecordOf, seoConfigOf } from "../data/seo.ts";
import { isAppPage } from "./app-pages.ts";

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Escapes the five characters XML reserves, so any URL can sit inside `<loc>`. */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * The scheme and host the sitemap's absolute URLs start with, from `url` in the site config. Without a valid `url`
 * the sitemap cannot be written, so the output reports a warning and returns `undefined`.
 */
function originOf(site: Site, ctx: OutputContext): string | undefined {
  const url = site.config.url?.trim() ?? "";
  const help = "Set `url` in the site config to the published scheme and host, such as `https://arminazimi.github.io`.";
  if (url === "") {
    ctx.report({
      id: "sitemap.no-url",
      severity: "warning",
      message: "sitemap.xml is not written: the site config has no `url`, and a sitemap needs absolute URLs.",
      help,
    });
    return undefined;
  }
  try {
    return new URL(url).origin;
  } catch {
    ctx.report({
      id: "sitemap.invalid-url",
      severity: "warning",
      message: `sitemap.xml is not written: the site config's \`url\` (${url}) is not an absolute URL.`,
      help,
    });
    return undefined;
  }
}

/** A date the sitemap protocol accepts, `YYYY-MM-DD`, from a value written as a date or an instant; else `undefined`. */
function dateOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^\d{4}-\d{2}-\d{2}/.exec(value.trim());
  if (!match) return undefined;
  const date = match[0];
  const time = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== date) return undefined;
  return date;
}

/**
 * The page's `lastmod`, as `YYYY-MM-DD` (a date the sitemap protocol accepts). A time and an offset after the date are
 * dropped. A value that is not a real calendar date is left out, not guessed.
 *
 * A record page of a collection that names a `seo.lastmod` field takes it from that field of the record, and leaves
 * `lastmod` out when the field is empty: never the build time, never a file's modification time. Every other page
 * takes its `updated` front matter.
 */
function lastmod(site: Site, page: Page): string | undefined {
  const field = seoConfigOf(site, page)?.lastmod;
  if (field !== undefined && page.record !== undefined) {
    const record = mainRecordOf(site, page);
    return record === undefined ? undefined : dateOf(record.fields[field]);
  }
  return dateOf(page.frontMatter.updated);
}

/**
 * A language tag as N37's `languageGroups` compares it: trimmed, lower case, `_` read as `-`.
 */
function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase().replace(/_/g, "-");
}

/** The tag and each shorter form: `pt-BR-x` → `["pt-br-x", "pt-br", "pt"]` (N37's `tagChain`). */
function tagChain(tag: string): readonly string[] {
  const parts = normalizeTag(tag).split("-").filter((part) => part !== "");
  const chain: string[] = [];
  for (let length = parts.length; length > 0; length--) chain.push(parts.slice(0, length).join("-"));
  return chain;
}

/** One alternate of a page: a language and the URL that serves it. */
interface Alternate {
  readonly lang: string;
  readonly url: string;
}

/**
 * The alternates of one page: every sitemap page in its language group (N37's `languageGroups`), one per language,
 * in the group's order (by language tag), then `x-default` pointing at the default language's page, or at the
 * group's first page when the default language has none. A language that no listed page serves is left out.
 *
 * Returns `undefined` when the group holds one language in the sitemap, so a single-language site writes the
 * sitemap it always has.
 */
function alternatesOf(
  page: Page,
  config: SiteConfig,
  groups: ReadonlyMap<string, readonly Page[]>,
  listed: ReadonlySet<string>,
  isCopy: (page: Page) => boolean,
): readonly Alternate[] | undefined {
  const group = groups.get(translationId(page, config));
  if (group === undefined || isCopy(page)) return undefined;

  const languages = new Set<string>();
  const alternates: Alternate[] = [];
  for (const entry of group) {
    const tag = normalizeTag(entry.lang);
    if (tag === "" || languages.has(tag) || !listed.has(entry.url) || isCopy(entry)) continue;
    languages.add(tag);
    alternates.push({ lang: entry.lang, url: entry.url });
  }
  if (alternates.length < 2) return undefined;

  const defaultTags = tagChain(config.lang);
  const xDefault = alternates.find((alternate) => defaultTags.includes(normalizeTag(alternate.lang))) ?? alternates[0];
  if (xDefault === undefined) return undefined;
  return [...alternates, { lang: "x-default", url: xDefault.url }];
}

/** The most URLs one sitemap file may hold, and the most bytes, as the sitemap protocol sets them. */
export interface SitemapLimits {
  readonly urls: number;
  readonly bytes: number;
}

/** The protocol's limits: 50,000 URLs and 50 MB (uncompressed) per file. */
export const SITEMAP_LIMITS: SitemapLimits = { urls: 50_000, bytes: 50 * 1024 * 1024 };

/** One sitemap entry as written, with the data the grouping and the index need. */
interface Entry {
  /** The `<url>` element, without a trailing newline. */
  readonly xml: string;
  /** `lastmod`, when the page has one. */
  readonly date: string | undefined;
  /** The collection the page belongs to; `""` for an ordinary page. */
  readonly group: string;
  readonly alternates: boolean;
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>';

/** The `<urlset>` document of some entries. The XHTML namespace is declared only when an entry carries alternates. */
function urlsetOf(entries: readonly Entry[]): string {
  const xmlns = [
    'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
    ...(entries.some((entry) => entry.alternates) ? ['xmlns:xhtml="http://www.w3.org/1999/xhtml"'] : []),
  ].join(" ");
  return [XML_HEAD, `<urlset ${xmlns}>`, ...entries.map((entry) => entry.xml), "</urlset>", ""].join("\n");
}

/** A collection name as a file name part: letters, digits, `.`, `_`, and `-` stay; any other run becomes `-`. */
function fileSlug(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "collection";
}

/**
 * Splits entries into files. A site that fits one file (within both limits) gets `sitemap.xml` and nothing else, as
 * it always did. A larger site gets `sitemap.xml` as an index and one file per collection, `sitemap-<collection>.xml`,
 * plus `sitemap-pages.xml` for the ordinary pages, so a data release rewrites few files. A group that is itself over a
 * limit continues in `-part-2`, `-part-3`, and so on. The index lists the files in path order; a file's `lastmod` in the index is
 * the latest of its entries, written only when every entry has one.
 */
function sitemapFiles(entries: readonly Entry[], origin: string, base: string, limits: SitemapLimits): OutputFile[] {
  const single = urlsetOf(entries);
  if (entries.length <= limits.urls && Buffer.byteLength(single) <= limits.bytes) {
    return [{ path: "sitemap.xml", contents: single }];
  }

  const groups = new Map<string, Entry[]>();
  for (const entry of entries) {
    const group = groups.get(entry.group);
    if (group === undefined) groups.set(entry.group, [entry]);
    else group.push(entry);
  }

  const used = new Set<string>(["sitemap.xml"]);
  const files: { path: string; entries: Entry[] }[] = [];
  for (const group of [...groups.keys()].sort(byCodePoint)) {
    const stem = `sitemap-${group === "" ? "pages" : fileSlug(group)}`;
    let part = 0;
    let chunk: Entry[] = [];
    let bytes = Buffer.byteLength(urlsetOf([]));
    const flush = (): void => {
      if (chunk.length === 0) return;
      part += 1;
      let path = part === 1 ? `${stem}.xml` : `${stem}-part-${part}.xml`;
      // Two collection names that read the same as file names never write the same file.
      while (used.has(path)) path = path.replace(/\.xml$/, "-x.xml");
      used.add(path);
      files.push({ path, entries: chunk });
      chunk = [];
      bytes = Buffer.byteLength(urlsetOf([]));
    };
    for (const entry of groups.get(group)!) {
      const size = Buffer.byteLength(entry.xml) + 1;
      // Leave room for the namespace the document may add.
      if (chunk.length > 0 && (chunk.length >= limits.urls || bytes + size + 64 > limits.bytes)) flush();
      chunk.push(entry);
      bytes += size;
    }
    flush();
  }

  files.sort((a, b) => byCodePoint(a.path, b.path));
  const prefix = `${origin}${base}`;
  const listed = files.map((file) => {
    const dates = file.entries.map((entry) => entry.date);
    const latest = dates.every((date) => date !== undefined) ? [...dates].sort(byCodePoint).at(-1) : undefined;
    return [
      "  <sitemap>",
      `    <loc>${escapeXml(`${prefix}/${file.path}`)}</loc>`,
      ...(latest === undefined ? [] : [`    <lastmod>${latest}</lastmod>`]),
      "  </sitemap>",
    ].join("\n");
  });
  const index = [
    XML_HEAD,
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...listed,
    "</sitemapindex>",
    "",
  ].join("\n");
  return [{ path: "sitemap.xml", contents: index }, ...files.map((file) => ({ path: file.path, contents: urlsetOf(file.entries) }))].sort(
    (a, b) => byCodePoint(a.path, b.path),
  );
}

/**
 * Writes `sitemap.xml`: one `<url>` per doc page, with the absolute URL (the config's `url` plus the page's URL, which
 * already carries `base`) and `lastmod` when the page has a date (`updated` front matter, or a record field named by
 * the collection's `seo.lastmod`). A page with `sitemap: false` is left out, and so is a page marked `noindex` (see
 * `src/data/seo.ts`) and every app page, because the config has no key that lists one (the frozen config schema
 * decides that).
 *
 * A page that has translations gets one `<xhtml:link rel="alternate">` per language of its group plus `x-default`,
 * and the document declares the XHTML namespace only when some page has alternates; a single-language site writes
 * exactly the bytes it wrote before. Entries come back sorted by URL. A site without a valid `url` gets no file and a
 * warning, and `url` is what makes every `href` absolute, as the protocol requires.
 *
 * A site over 50,000 URLs, or whose file would pass 50 MB, gets `sitemap.xml` as an index of one file per collection
 * (see {@link sitemapFiles}); `robots.txt` names `sitemap.xml` either way, so it always points at the index.
 */
export async function writeSitemap(site: Site, ctx: OutputContext, limits: SitemapLimits): Promise<readonly OutputFile[]> {
  const origin = originOf(site, ctx);
  if (origin === undefined) return [];

  const appPages = { pages: site.pages.filter((page) => page.kind === "app") };
  const pages = site.pages
    .filter((p) => p.kind === "doc" && p.frontMatter.sitemap !== false && !isNoindex(site, p) && !isAppPage(p.url, appPages))
    .sort((a, b) => byCodePoint(a.url, b.url));

  const groups = languageGroups(site);
  const listed = new Set(pages.map((p) => p.url));
  const entries: Entry[] = pages.map((page) => {
    const alternates = alternatesOf(page, site.config, groups, listed, (candidate) => isFallbackCopy(site, candidate));
    const loc = escapeXml(new URL(page.url, origin).href);
    const date = lastmod(site, page);
    const xml = [
      "  <url>",
      `    <loc>${loc}</loc>`,
      ...(date === undefined ? [] : [`    <lastmod>${date}</lastmod>`]),
      ...(alternates ?? []).map((alternate) => {
        const href = escapeXml(new URL(alternate.url, origin).href);
        return `    <xhtml:link rel="alternate" hreflang="${escapeXml(alternate.lang)}" href="${href}"/>`;
      }),
      "  </url>",
    ].join("\n");
    return { xml, date, group: page.record?.collection ?? page.list?.collection ?? "", alternates: alternates !== undefined };
  });

  return sitemapFiles(entries, origin, site.config.base, limits);
}

export const sitemap: Output = {
  name: "sitemap",
  run: (site: Site, ctx: OutputContext) => writeSitemap(site, ctx, SITEMAP_LIMITS),
};
