/**
 * `mizzen published-site check`: the addresses a sitemap or sitemap index names. An index may name a sitemap or
 * another index, so the reader walks it depth first and stops on a cycle. Every page URL is returned once, in sitemap
 * order; duplicates, a cycle, a foreign host, and every documented limit become findings rather than silent changes.
 */
import { gunzipSync } from "node:zlib";

/** The most `<loc>` values one sitemap file may hold. */
export const SITEMAP_MAX_LOCS = 50_000;
/** The most bytes one sitemap file may hold uncompressed. */
export const SITEMAP_MAX_BYTES = 50 * 1024 * 1024;
/** The most sitemap files one check may read. */
export const SITEMAP_MAX_FILES = 100;
/** How deep an index may nest; the root sitemap is depth 0. */
export const SITEMAP_MAX_DEPTH = 5;
/** The most page URLs one check may collect. */
export const SITEMAP_MAX_URLS = 50_000;
/** How long one request may take. */
export const SITEMAP_TIMEOUT_MS = 10_000;

/** A finding id this reader can produce. */
export type SitemapFindingId =
  | "published-site.sitemap"
  | "published-site.sitemap-cycle"
  | "published-site.sitemap-limit"
  | "published-site.sitemap-duplicate"
  | "published-site.domain";

/** One problem found while reading sitemaps. */
export interface SitemapFinding {
  readonly id: SitemapFindingId;
  readonly severity: "error" | "warning";
  /** The sitemap or page address the finding concerns. */
  readonly url: string;
  readonly message: string;
  readonly expected?: string;
  readonly actual?: string;
}

/** What {@link enumerateSitemaps} returns. */
export interface SitemapEnumeration {
  /** The page URLs in sitemap order, each written once. */
  readonly urls: readonly string[];
  readonly findings: readonly SitemapFinding[];
}

/** A `fetch` with the one shape this unit uses, so a test can serve sitemaps without a network. */
export type SitemapFetchLike = (url: string, init?: RequestInit) => Promise<Response>;

class SitemapTooLarge extends Error {}

/** The lower-cased hostname without a trailing dot, which is how two addresses compare. */
function hostOf(url: URL): string {
  return url.hostname.toLowerCase().replace(/\.$/, "");
}

/** A numeric XML entity, left out when its value is not a Unicode code point. */
function codePoint(value: number): string {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : "";
}

/** The XML entities a `<loc>` may carry. */
function decodeXml(text: string): string {
  return text.trim().replace(/&(?:#(\d+)|#x([\da-f]+)|(amp|lt|gt|quot|apos));/gi, (entity, dec: string | undefined, hex: string | undefined, named: string | undefined) => {
    if (dec !== undefined) return codePoint(Number(dec));
    if (hex !== undefined) return codePoint(Number.parseInt(hex, 16));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[named!.toLowerCase()]!;
  });
}

/** Every `<loc>` value in a sitemap file, in document order. */
function locsOf(xml: string): string[] {
  return [...xml.matchAll(/<loc(?:\s[^>]*)?>\s*([\s\S]*?)\s*<\/loc>/g)].map((match) => decodeXml(match[1]!)).filter((loc) => loc !== "");
}

function problemOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reads one sitemap response; a `.xml.gz` address is decompressed and the uncompressed size is bounded. */
async function readSitemapFile(url: string, fetch: SitemapFetchLike): Promise<string> {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(SITEMAP_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  let bytes = new Uint8Array(await response.arrayBuffer());
  if (new URL(url).pathname.endsWith(".gz")) {
    try {
      bytes = new Uint8Array(gunzipSync(bytes, { maxOutputLength: SITEMAP_MAX_BYTES + 1 }));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ERR_BUFFER_TOO_LARGE") throw new SitemapTooLarge(`The sitemap is larger than ${SITEMAP_MAX_BYTES} bytes.`);
      throw new Error(`the gzip stream could not be read`);
    }
  }
  if (bytes.byteLength > SITEMAP_MAX_BYTES) throw new SitemapTooLarge(`The sitemap is larger than ${SITEMAP_MAX_BYTES} bytes.`);
  return new TextDecoder().decode(bytes);
}

/**
 * Reads the sitemap at `options.sitemap`, following indexes, and returns every page URL on the allowed domain.
 * The sitemap URL itself may be on any host; the host of every address it names must be `options.domain`, which
 * defaults to the sitemap's own host. Nothing on another host is requested.
 */
export async function enumerateSitemaps(options: {
  readonly sitemap: string;
  readonly domain?: string;
  readonly fetch: SitemapFetchLike;
}): Promise<SitemapEnumeration> {
  const root = new URL(options.sitemap);
  const domain = (options.domain ?? hostOf(root)).toLowerCase().replace(/\.$/, "");
  const findings: SitemapFinding[] = [];
  const urls: string[] = [];
  const pages = new Set<string>();
  const read = new Set<string>();
  const duplicates = new Set<string>();
  let files = 0;
  let stopped = false;

  function add(id: SitemapFindingId, severity: "error" | "warning", url: string, message: string, expected?: string, actual?: string): void {
    findings.push({ id, severity, url, message, ...(expected === undefined ? {} : { expected }), ...(actual === undefined ? {} : { actual }) });
  }

  function limit(url: string, message: string, expected: string, actual: string): void {
    add("published-site.sitemap-limit", "error", url, message, expected, actual);
  }

  /** A parsed address on the allowed domain, or undefined after a finding. */
  function allowed(loc: string, at: string): URL | undefined {
    let url: URL;
    try {
      url = new URL(loc);
    } catch {
      add("published-site.sitemap", "error", at, `The sitemap names ${JSON.stringify(loc)}, which is not an absolute URL.`);
      return undefined;
    }
    const host = hostOf(url);
    if (host !== domain) {
      add("published-site.domain", "error", url.href, `The address is on ${host}, but the check may request only ${domain}.`, domain, host);
      return undefined;
    }
    return url;
  }

  function readPage(loc: string, at: string): void {
    const url = allowed(loc, at);
    if (url === undefined) return;
    const href = url.href;
    if (pages.has(href)) {
      if (!duplicates.has(href)) {
        duplicates.add(href);
        add("published-site.sitemap-duplicate", "warning", href, `The page URL ${href} appears more than once; it is checked once.`);
      }
      return;
    }
    if (urls.length >= SITEMAP_MAX_URLS) {
      limit(href, `The sitemaps name more than ${SITEMAP_MAX_URLS} page URLs.`, `at most ${SITEMAP_MAX_URLS} page URLs`, "more");
      stopped = true;
      return;
    }
    pages.add(href);
    urls.push(href);
  }

  async function readMap(address: string, depth: number): Promise<void> {
    if (stopped) return;
    const href = new URL(address).href;
    if (read.has(href)) {
      add("published-site.sitemap-cycle", "error", href, `The sitemap ${href} is reached again, so the index is cyclic.`);
      return;
    }
    if (files >= SITEMAP_MAX_FILES) {
      limit(href, `The check reads at most ${SITEMAP_MAX_FILES} sitemap files.`, `at most ${SITEMAP_MAX_FILES} sitemap files`, `more than ${SITEMAP_MAX_FILES}`);
      stopped = true;
      return;
    }
    read.add(href);
    files += 1;
    let xml: string;
    try {
      xml = await readSitemapFile(href, options.fetch);
    } catch (error) {
      if (error instanceof SitemapTooLarge) {
        limit(href, error.message, `at most ${SITEMAP_MAX_BYTES} bytes`, `more than ${SITEMAP_MAX_BYTES} bytes`);
        return;
      }
      add("published-site.sitemap", "error", href, `The sitemap ${href} could not be fetched: ${problemOf(error)}.`);
      return;
    }
    const locs = locsOf(xml);
    if (locs.length > SITEMAP_MAX_LOCS) {
      limit(href, `The sitemap has ${locs.length} <loc> values, more than the ${SITEMAP_MAX_LOCS} allowed.`, `at most ${SITEMAP_MAX_LOCS} <loc> values`, String(locs.length));
      return;
    }
    if (locs.length === 0) {
      add("published-site.sitemap", "error", href, `The sitemap ${href} has no <loc> value.`);
      return;
    }
    if (/<sitemapindex[\s>]/.test(xml)) {
      if (depth > SITEMAP_MAX_DEPTH) {
        limit(href, `The index is nested deeper than ${SITEMAP_MAX_DEPTH} levels.`, `at most ${SITEMAP_MAX_DEPTH} levels`, String(depth));
        stopped = true;
        return;
      }
      for (const loc of locs) {
        if (stopped) return;
        const child = allowed(loc, href);
        if (child !== undefined) await readMap(child.href, depth + 1);
      }
      return;
    }
    if (/<urlset[\s>]/.test(xml)) {
      for (const loc of locs) {
        if (stopped) return;
        readPage(loc, href);
      }
      return;
    }
    add("published-site.sitemap", "error", href, `The sitemap ${href} is not a <urlset> or a <sitemapindex>.`);
  }

  await readMap(root.href, 0);
  return { urls, findings };
}
