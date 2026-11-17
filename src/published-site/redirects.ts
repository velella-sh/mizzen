/**
 * Follows each address in a published-site redirect map to its final destination and compares it with the address
 * the map expects. A loop, a chain longer than the hop limit, and a wrong destination are separate findings. The
 * caller supplies the fetcher, so a test never opens a connection, and no redirect is followed off the allowed domain.
 */

/** How many redirects one address may follow. */
export const REDIRECT_HOP_LIMIT = 5;
/** How long one request may take. */
export const REDIRECT_TIMEOUT_MS = 10_000;

/** A `fetch` with the one shape this unit uses, so a test can answer without a network. */
export type PublishedSiteFetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** The redirect findings this unit reports. */
export type RedirectProblem =
  | "published-site.domain"
  | "published-site.unreachable"
  | "published-site.redirect-mismatch"
  | "published-site.redirect-loop"
  | "published-site.redirect-chain";

/** One redirect problem, as the report contract carries it. */
export interface RedirectFinding {
  /** Stable diagnostic id. */
  readonly id: RedirectProblem;
  readonly severity: "error";
  /** The address the finding concerns. */
  readonly url: string;
  readonly message: string;
  readonly expected?: string;
  readonly actual?: string;
}

/** What {@link checkRedirects} needs: the origin that resolves paths, the allowed host, the map, and the fetcher. */
export interface RedirectCheckOptions {
  /** The sitemap URL's origin, against which a map path is resolved. */
  readonly origin: string;
  /** The one host the check may request. */
  readonly domain: string;
  /** A source address to the final address it must reach. A path resolves against `origin`. */
  readonly redirects: Readonly<Record<string, string>>;
  readonly fetch: PublishedSiteFetchLike;
}

/** Lower-cased, punycode hostname without a trailing dot. */
function hostnameOf(url: URL): string {
  return url.hostname.toLowerCase().replace(/\.$/, "");
}

function normalizeDomain(domain: string): string {
  return hostnameOf(new URL(`https://${domain}/`));
}

/** A URL as the redirect map compares it: no fragment, and defaults filled in by the URL parser. */
function normalize(address: string, base: string): string {
  const url = new URL(address, base);
  url.hash = "";
  return url.href;
}

function finding(
  id: RedirectProblem,
  url: string,
  message: string,
  values: { readonly expected?: string; readonly actual?: string } = {},
): RedirectFinding {
  return { id, severity: "error", url, message, ...values };
}

/** Follows one map entry and returns its findings; the first problem ends the chain. */
async function follow(
  source: string,
  expected: string,
  allowed: string,
  fetcher: PublishedSiteFetchLike,
): Promise<RedirectFinding[]> {
  const sourceHost = hostnameOf(new URL(source));
  if (sourceHost !== allowed) {
    return [finding("published-site.domain", source, `The redirect source ${source} is not on the allowed domain ${allowed}.`, { expected: allowed, actual: sourceHost })];
  }
  const visited = new Set([source]);
  let current = source;
  let hops = 0;
  for (;;) {
    let response: Response;
    try {
      response = await fetcher(current, { redirect: "manual", signal: AbortSignal.timeout(REDIRECT_TIMEOUT_MS) });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return [finding("published-site.unreachable", current, `The request to ${current} failed: ${detail}.`)];
    }
    const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
    if (location === null) {
      if (current === expected) return [];
      return [finding("published-site.redirect-mismatch", source, `The redirect ended at ${current}, expected ${expected}.`, { expected, actual: current })];
    }
    const next = normalize(location, current);
    const nextHost = hostnameOf(new URL(next));
    if (nextHost !== allowed) {
      return [finding("published-site.domain", next, `The redirect from ${current} leaves the allowed domain ${allowed} for ${next}.`, { expected: allowed, actual: nextHost })];
    }
    if (visited.has(next)) {
      return [finding("published-site.redirect-loop", source, `The redirect from ${current} returns to ${next}, which was already visited.`, { actual: next })];
    }
    if (hops === REDIRECT_HOP_LIMIT) {
      return [finding("published-site.redirect-chain", source, `The redirect chain from ${source} is longer than ${REDIRECT_HOP_LIMIT} hops; it reached ${current}.`, { expected, actual: current })];
    }
    visited.add(next);
    current = next;
    hops++;
  }
}

/** Sorts findings by address, then id, in code-point order. */
function compareFindings(a: RedirectFinding, b: RedirectFinding): number {
  if (a.url !== b.url) return a.url < b.url ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/** Requests every map entry, follows its redirects, and reports where a loop, a long chain, or a wrong destination broke the map. */
export async function checkRedirects(options: RedirectCheckOptions): Promise<readonly RedirectFinding[]> {
  const base = new URL("/", options.origin).href;
  const allowed = normalizeDomain(options.domain);
  const entries = new Map<string, string>();
  for (const [from, to] of Object.entries(options.redirects)) {
    const source = normalize(from, base);
    if (!entries.has(source)) entries.set(source, normalize(to, base));
  }
  const findings: RedirectFinding[] = [];
  for (const [source, expected] of entries) findings.push(...(await follow(source, expected, allowed, options.fetch)));
  return findings.sort(compareFindings);
}
