/**
 * Checks one published page: the host answers with a `2xx` status, and the page names its own final URL as canonical.
 * A test injects the fetcher, so this unit never opens a socket on its own. Redirect destinations are checked elsewhere.
 */
export const PAGE_TIMEOUT_MS = 10_000;

/** A `fetch` with the one shape this unit uses, so a test can answer without a socket. */
export type PageFetch = (url: string, init: RequestInit) => Promise<Response>;

/** One finding about a page: its stable id, the address, and the values when the check knows them. */
export interface PageFinding {
  readonly id: string;
  readonly severity: "error";
  readonly url: string;
  readonly message: string;
  readonly expected?: string;
  readonly actual?: string;
}

const LINK_TAG = /<link\b[^>]*>/gi;
const REL = /\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

/** The value of a matched attribute, whichever quoting the author used. */
function attribute(match: RegExpExecArray | null): string | undefined {
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

/** Decodes the entities an `href` may carry without pulling in an HTML parser. */
function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&(?:quot|#34|#x22);/gi, '"')
    .replace(/&(?:apos|#39|#x27);/gi, "'");
}

/** Every `href` on a `<link rel="canonical">`, in document order. A canonical without `href` counts as no URL. */
function canonicalHrefs(html: string): string[] {
  const hrefs: string[] = [];
  for (const [tag] of html.matchAll(LINK_TAG)) {
    const rel = attribute(REL.exec(tag ?? ""));
    if (rel === undefined || !rel.toLowerCase().split(/\s+/).includes("canonical")) continue;
    const href = attribute(HREF.exec(tag ?? ""))?.trim();
    if (href !== undefined && href !== "") hrefs.push(decodeEntities(href));
  }
  return hrefs;
}

/** A URL in comparable form: no fragment, and an empty path read as `/`. `undefined` for text that is not a URL. */
function normalize(address: string): string | undefined {
  try {
    const url = new URL(address);
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

/** Resolves a canonical `href` against the page URL, then normalizes it. */
function absolute(href: string, page: string): string {
  try {
    return normalize(new URL(href, page).href) ?? href;
  } catch {
    return href;
  }
}

/** True when an injected or native fetcher failed because the request ran out of time. */
function timedOut(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

/** The one-sentence reason a request failed, without a trailing period of its own. */
function reason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\.+$/, "");
}

/** Checks `page` with `fetcher`; a `2xx` page must carry exactly one canonical URL equal to its own. */
export async function checkPage(page: string, fetcher: PageFetch = fetch): Promise<readonly PageFinding[]> {
  const request: RequestInit = {
    redirect: "follow",
    headers: { accept: "text/html, */*" },
    signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
  };
  let response: Response;
  try {
    response = await fetcher(page, request);
  } catch (error) {
    return [{
      id: "published-site.unreachable",
      severity: "error",
      url: page,
      message: timedOut(error) ? `The request to ${page} timed out.` : `The request to ${page} failed: ${reason(error)}.`,
    }];
  }
  if (!response.ok) {
    return [{
      id: "published-site.status",
      severity: "error",
      url: page,
      message: `The page returned ${response.status}, expected 2xx.`,
      expected: "2xx",
      actual: String(response.status),
    }];
  }
  let html: string;
  try {
    html = await response.text();
  } catch (error) {
    return [{
      id: "published-site.unreachable",
      severity: "error",
      url: page,
      message: `The response to ${page} could not be read: ${reason(error)}.`,
    }];
  }
  const final = response.url === "" ? page : response.url;
  const expected = normalize(final) ?? final;
  const hrefs = canonicalHrefs(html);
  if (hrefs.length === 0) {
    return [{
      id: "published-site.canonical-missing",
      severity: "error",
      url: page,
      message: `The page names no canonical URL, expected ${expected}.`,
      expected,
    }];
  }
  const found = hrefs.map((href) => absolute(href, final));
  if (found.length > 1) {
    const actual = found.join(", ");
    return [{
      id: "published-site.canonical-mismatch",
      severity: "error",
      url: page,
      message: `The page names ${found.length} canonical URLs (${actual}), expected only ${expected}.`,
      expected,
      actual,
    }];
  }
  const actual = found[0] ?? "";
  if (actual === expected) return [];
  return [{
    id: "published-site.canonical-mismatch",
    severity: "error",
    url: page,
    message: `The page names ${actual} as canonical, expected ${expected}.`,
    expected,
    actual,
  }];
}
