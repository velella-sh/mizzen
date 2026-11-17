/**
 * `mizzen published-site check`: starts at a published sitemap or sitemap index, requests every page on the allowed
 * domain, checks each page's status and canonical URL, follows every entry of an optional redirect map, and prints one
 * text or JSON report. It is never part of a build: a build opens no network connection.
 */
import { readFile } from "node:fs/promises";
import { fetchFollowingRedirects } from "../published-site/fetch.ts";
import { checkPage, type PageFetch } from "../published-site/pages.ts";
import { checkRedirects } from "../published-site/redirects.ts";
import { enumerateSitemaps } from "../published-site/sitemaps.ts";

/** What the command prints through. */
export interface PublishedSiteIo {
  readonly log: (message: string) => void;
  readonly error: (message: string) => void;
  /** The fetcher every request uses; defaults to the global `fetch`. */
  readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}

/** The help text of the `published-site` command. */
export const publishedSiteUsage = `Usage: mizzen published-site check --sitemap <url> [options]

Options:
  --sitemap <url>      Absolute sitemap or sitemap index URL to start from
  --domain <host>      The one host the check may request (default: the sitemap's host)
  --redirects <file>   JSON object from a source address to the final address it must reach
  --format <format>    text (default) or json

Exit codes: 0 ok, 1 problems, 2 usage.`;

/** One finding, as the report contract carries it. */
interface Finding {
  readonly id: string;
  readonly severity: "error" | "warning";
  readonly url: string;
  readonly message: string;
  readonly expected?: string;
  readonly actual?: string;
}

/** Lower-cased hostname without a trailing dot. */
function hostOf(url: URL): string {
  return url.hostname.toLowerCase().replace(/\.$/, "");
}

/** A URL as the check compares it: no fragment. */
function normalize(address: string, base: string): string {
  const url = new URL(address, base);
  url.hash = "";
  return url.href;
}

/** The sitemap URL, or `undefined` when it is not an absolute `http`/`https` URL without credentials or a fragment. */
function sitemapUrl(raw: string): URL | undefined {
  try {
    const url = new URL(raw);
    const web = url.protocol === "http:" || url.protocol === "https:";
    return web && url.username === "" && url.password === "" && url.hash === "" ? url : undefined;
  } catch {
    return undefined;
  }
}

/** The hostname `raw` names, or `undefined` when it is not one bare hostname. */
function hostname(raw: string): string | undefined {
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.?$/i.test(raw)) return undefined;
  try {
    return hostOf(new URL(`https://${raw}/`));
  } catch {
    return undefined;
  }
}

type RedirectMap = { readonly redirects: Record<string, string> } | { readonly error: string };

/** Reads and checks the redirect map before the first request; a bad map is a usage error, never a finding. */
async function readRedirectMap(file: string, origin: string, domain: string): Promise<RedirectMap> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { error: `the redirect map ${file} could not be read: ${detail}` };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { error: `the redirect map ${file} is not valid JSON` };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { error: `the redirect map ${file} must be a JSON object of addresses` };
  }
  for (const [from, to] of Object.entries(value)) {
    if (from === "" || typeof to !== "string" || to === "") {
      return { error: `the redirect map ${file} must map every non-empty address to a non-empty address` };
    }
    for (const [label, address] of [["source", from], ["target", to]] as const) {
      let url: URL;
      try {
        url = new URL(address, origin);
      } catch {
        return { error: `the redirect ${label} ${address} is not an address` };
      }
      if (hostOf(url) !== domain) {
        return { error: `the redirect ${label} ${address} is not on the allowed domain ${domain}` };
      }
    }
  }
  return { redirects: value as Record<string, string> };
}

/** Findings by address, then id, in code-point order. */
function compareFindings(a: Finding, b: Finding): number {
  if (a.url !== b.url) return a.url < b.url ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/** Runs `mizzen published-site check ...`. Returns the exit code. */
export async function runPublishedSite(args: readonly string[], io: PublishedSiteIo): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === undefined || subcommand === "-h" || subcommand === "--help" || subcommand === "help") {
    io.log(publishedSiteUsage);
    return subcommand === undefined ? 2 : 0;
  }
  if (subcommand !== "check") {
    io.error(`mizzen: unknown published-site subcommand: ${subcommand}`);
    return 2;
  }

  let sitemap: string | undefined;
  let domain: string | undefined;
  let redirectsFile: string | undefined;
  let format: "text" | "json" = "text";
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "-h" || arg === "--help") {
      io.log(publishedSiteUsage);
      return 0;
    }
    if (arg !== "--sitemap" && arg !== "--domain" && arg !== "--redirects" && arg !== "--format") {
      io.error(arg.startsWith("-") ? `mizzen: unknown option: ${arg}` : `mizzen: unexpected argument: ${arg}`);
      return 2;
    }
    const value = rest[++i];
    if (value === undefined || value.startsWith("-")) {
      io.error(`mizzen: ${arg} needs a value`);
      return 2;
    }
    if (arg === "--sitemap") sitemap = value;
    else if (arg === "--domain") domain = value;
    else if (arg === "--redirects") redirectsFile = value;
    else if (value === "text" || value === "json") format = value;
    else {
      io.error(`mizzen: --format must be text or json, not ${value}`);
      return 2;
    }
  }

  if (sitemap === undefined) {
    io.error("mizzen: published-site check needs --sitemap <url>");
    return 2;
  }
  const start = sitemapUrl(sitemap);
  if (start === undefined) {
    io.error(`mizzen: --sitemap must be an absolute http or https URL without credentials or a fragment, not ${sitemap}`);
    return 2;
  }
  const allowed = domain === undefined ? hostOf(start) : hostname(domain);
  if (allowed === undefined) {
    io.error(`mizzen: --domain must be one hostname, not ${domain}`);
    return 2;
  }

  let redirects: Record<string, string> = {};
  if (redirectsFile !== undefined) {
    const read = await readRedirectMap(redirectsFile, start.origin, allowed);
    if ("error" in read) {
      io.error(`mizzen: ${read.error}`);
      return 2;
    }
    redirects = read.redirects;
  }

  const fetcher = io.fetch ?? ((url: string, init?: RequestInit) => fetch(url, init));
  const redirected = new Map<string, string>();
  const findings: Finding[] = [];
  const pageFetch: PageFetch = async (url, init) => {
    const followed = await fetchFollowingRedirects(url, allowed, init, fetcher);
    if (followed.finding !== undefined) findings.push(followed.finding);
    else if (followed.final !== normalize(url, url)) redirected.set(normalize(url, url), followed.final);
    return followed.response;
  };

  const enumeration = await enumerateSitemaps({ sitemap: start.href, domain: allowed, fetch: fetcher });
  findings.push(...enumeration.findings);
  for (const page of enumeration.urls) findings.push(...(await checkPage(page, pageFetch)));
  findings.push(...(await checkRedirects({ origin: start.origin, domain: allowed, redirects, fetch: fetcher })));

  const sources = new Set(Object.keys(redirects).map((from) => normalize(from, start.origin)));
  for (const [page, final] of redirected) {
    if (sources.has(page)) continue;
    findings.push({
      id: "published-site.redirect-unexpected",
      severity: "error",
      url: page,
      message: `The page redirects to ${final}, but the redirect map has no entry for it.`,
      actual: final,
    });
  }

  const sorted = findings.sort(compareFindings);
  const errors = sorted.filter((finding) => finding.severity === "error").length;
  const warnings = sorted.length - errors;
  const urls = new Set([...enumeration.urls, ...sources]).size;

  if (format === "json") {
    io.log(JSON.stringify({
      version: 1,
      sitemap: start.href,
      domain: allowed,
      urls,
      findings: sorted.map((finding) => ({
        id: finding.id,
        severity: finding.severity,
        url: finding.url,
        message: finding.message,
        ...(finding.expected === undefined ? {} : { expected: finding.expected }),
        ...(finding.actual === undefined ? {} : { actual: finding.actual }),
      })),
    }, null, 2));
  } else {
    for (const finding of sorted) io.log(`${finding.severity} ${finding.id} ${finding.url}: ${finding.message}`);
    io.log(`URLs checked: ${urls}; errors: ${errors}; warnings: ${warnings}.`);
  }
  return errors === 0 ? 0 : 1;
}
