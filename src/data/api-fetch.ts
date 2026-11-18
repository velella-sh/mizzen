/**
 * `mizzen data fetch` for a JSON API: reads the record array of one response, or walks a paginated API by page
 * number, offset, cursor, or next-page URL, and stores every record as one JSON list. The run is bounded by a page
 * cap, a byte cap, and a retry count; a repeated cursor stops it. A credential is read from the environment and sent
 * only to an allowed origin. Nothing here writes: the caller stores the bytes and the page manifest atomically.
 *
 * Every problem is a diagnostic, never a throw. `docs/api-fetch.md` states the defaults and each diagnostic id.
 */
import type { Diagnostic } from "../contracts/index.ts";
import type { ApiAuthConfig, PaginationConfig } from "../contracts/config.ts";
import type { DataLimits } from "./limits.ts";
import { sha256 } from "./lock.ts";

/** How long one request may take. */
export const API_TIMEOUT_MS = 30_000;

/** How many redirects one request may follow. */
export const API_REDIRECTS = 5;

/** Most pages one fetch reads when the config sets no `maxPages`. */
export const DEFAULT_API_MAX_PAGES = 50;

/** Most times one request is retried when the config sets no `retries`. */
export const DEFAULT_API_RETRIES = 2;

/** A `fetch` with the one shape this module uses. */
export type ApiFetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** One page of a fetched API, in fetch order, as the lock records it. */
export interface ApiPage {
  /** The response's final URL. */
  readonly url: string;
  /** Byte size of the page's body. */
  readonly bytes: number;
  /** SHA-256 of the page's body. */
  readonly sha256: string;
}

/** What one fetch read, or why it stopped. */
export interface ApiFetchResult {
  /** The records as canonical pretty JSON, ready to store. */
  readonly bytes?: Uint8Array;
  /** The pages in fetch order. */
  readonly pages?: readonly ApiPage[];
  /** Number of records read. */
  readonly records?: number;
  /** The first page's date header, when it has one. */
  readonly fetchedAt?: string;
  /** The one problem that stopped the fetch. */
  readonly diagnostic?: Diagnostic;
}

/** What {@link fetchApiSource} needs. */
export interface ApiFetchOptions {
  /** The collection's name, for messages. */
  readonly collection: string;
  /** The source address as the config writes it. */
  readonly source: string;
  /** Dot path to the record array in each response. */
  readonly records: string;
  /** How to ask for the next page. Unset: one request. */
  readonly pagination?: PaginationConfig;
  /** Field that holds a record's id, for the duplicate check. Default `id`. */
  readonly idField: string;
  /** The collection's build limits; `limits.bytes` caps the stored list. */
  readonly limits: DataLimits;
  /** The fetcher; tests pass one that talks to a local server. */
  readonly fetcher: ApiFetchLike;
  /** The environment the credential is read from. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** True for a host a plain-http source may name: the loopback interface only. */
export function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

/** True for an address `mizzen data fetch` may open: `https:`, or plain `http:` on the loopback interface. */
export function isFetchableUrl(url: URL): boolean {
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && isLoopbackHost(url.hostname);
}

/** One failure with the id a test and a reader can name. */
function failure(id: string, message: string, help?: string): ApiFetchResult {
  return { diagnostic: { id, severity: "error", message, ...(help === undefined ? {} : { help }) } };
}

/** A URL a fetch may open; `undefined` with a diagnostic when it is not one. */
function fetchableUrl(value: string, collection: string): { readonly url?: URL; readonly diagnostic?: Diagnostic } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { diagnostic: failure("data.api-url", `Collection "${collection}" reads "${value}", which is not a URL.`).diagnostic };
  }
  if (!isFetchableUrl(url)) {
    const allowed = url.protocol === "http:" ? "https, or http on the loopback interface" : "https";
    return { diagnostic: failure("data.api-url", `Collection "${collection}" reads "${url.href}", which is not ${allowed}.`).diagnostic };
  }
  return { url };
}

/** The request URL for one page: the source URL with the mode's parameter set. */
function pageUrl(base: URL, mode: PaginationConfig["mode"] | undefined, param: string, value: number | string): URL {
  const url = new URL(base.href);
  if (mode !== undefined) url.searchParams.set(param, String(value));
  return url;
}

/** The value at a dot path, own properties only; `undefined` when any segment is absent. */
export function valueAtPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    if (!Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Whether a response status is worth retrying: a rate limit, a timeout, or a server fault. */
function transientStatus(status: number): boolean {
  return status === 429 || status === 408 || status === 500 || status === 502 || status === 503 || status === 504;
}

/** The body as bytes, stopping at `remaining` and cancelling the stream when it would pass. */
async function readBody(response: Response, remaining: number, collection: string, maxBytes: number): Promise<{ readonly bytes?: Uint8Array; readonly diagnostic?: Diagnostic }> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > remaining) {
    await response.body?.cancel().catch(() => undefined);
    return { diagnostic: failure("data.api-too-large", `Collection "${collection}" reads more than ${maxBytes} bytes across its pages; the limit is ${maxBytes}.`, `Raise collections.${collection}.pagination.maxBytes, or split the API.`).diagnostic };
  }
  const reader = response.body?.getReader();
  if (reader === undefined) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > remaining) {
      return { diagnostic: failure("data.api-too-large", `Collection "${collection}" reads more than ${maxBytes} bytes across its pages; the limit is ${maxBytes}.`, `Raise collections.${collection}.pagination.maxBytes, or split the API.`).diagnostic };
    }
    return { bytes };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > remaining) {
      await reader.cancel().catch(() => undefined);
      return { diagnostic: failure("data.api-too-large", `Collection "${collection}" reads more than ${maxBytes} bytes across its pages; the limit is ${maxBytes}.`, `Raise collections.${collection}.pagination.maxBytes, or split the API.`).diagnostic };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes };
}

/** The date a response states, as a UTC instant, or `undefined`. */
function instantOfHttpDate(value: string | null): string | undefined {
  if (value === null) return undefined;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return undefined;
  return new Date(time).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** One response's bytes and final URL, after redirects and retries. */
interface PageResponse {
  readonly bytes?: Uint8Array;
  readonly url?: string;
  readonly fetchedAt?: string;
  readonly diagnostic?: Diagnostic;
}

/** Reads one page with bounded redirects and retries; auth is attached only to an allowed origin. */
async function requestPage(
  url: URL,
  options: ApiFetchOptions,
  allowed: ReadonlySet<string>,
  remaining: number,
  maxBytes: number,
  auth: { readonly header: string; readonly value: string } | undefined,
): Promise<PageResponse> {
  const pagination = options.pagination;
  const retries = pagination?.retries ?? DEFAULT_API_RETRIES;
  let current = url;
  for (let redirects = 0; redirects <= API_REDIRECTS; redirects++) {
    if (!allowed.has(current.origin)) {
      return {
        diagnostic: failure("data.api-origin", `Collection "${options.collection}" may not reach ${current.origin}; allowed: ${[...allowed].sort().join(", ")}.`, `Add the origin under collections.${options.collection}.pagination.origins.`).diagnostic,
      };
    }
    let response: Response | undefined;
    let thrown: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      thrown = undefined;
      try {
        const headers: Record<string, string> = { accept: "application/json, */*" };
        if (auth !== undefined) headers[auth.header] = auth.value;
        response = await options.fetcher(current.href, {
          redirect: "manual",
          headers,
          signal: AbortSignal.timeout(API_TIMEOUT_MS),
        });
      } catch (err) {
        response = undefined;
        thrown = err;
        if (attempt < retries) continue;
        const detail = err instanceof Error ? err.message : String(err);
        return { diagnostic: failure("data.api-request", `Collection "${options.collection}" could not read ${current.href} after ${attempt + 1} attempts: ${detail}`).diagnostic };
      }
      if (response.status >= 200 && response.status < 300) break;
      if (response.status >= 300 && response.status < 400) break;
      if (!transientStatus(response.status) || attempt === retries) break;
    }
    if (response === undefined) {
      const detail = thrown instanceof Error ? thrown.message : String(thrown);
      return { diagnostic: failure("data.api-request", `Collection "${options.collection}" could not read ${current.href}: ${detail}`).diagnostic };
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location === null) return { diagnostic: failure("data.api-redirect", `HTTP ${response.status} from ${current.href} names no location.`).diagnostic };
      if (redirects === API_REDIRECTS) return { diagnostic: failure("data.api-redirect", `${options.source} redirects more than ${API_REDIRECTS} times.`).diagnostic };
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        return { diagnostic: failure("data.api-redirect", `HTTP ${response.status} from ${current.href} names "${location}", which is not a URL.`).diagnostic };
      }
      if (!isFetchableUrl(next)) return { diagnostic: failure("data.api-url", `Collection "${options.collection}" may not redirect to "${next.href}".`).diagnostic };
      current = next;
      continue;
    }
    if (!response.ok) {
      return { diagnostic: failure("data.api-http", `HTTP ${response.status} from ${current.href}.`).diagnostic };
    }

    const body = await readBody(response, remaining, options.collection, maxBytes);
    if (body.diagnostic !== undefined) return { diagnostic: body.diagnostic };
    const fetchedAt = instantOfHttpDate(response.headers.get("last-modified")) ?? instantOfHttpDate(response.headers.get("date"));
    return {
      bytes: body.bytes!,
      url: current.href,
      ...(fetchedAt === undefined ? {} : { fetchedAt }),
    };
  }
  return { diagnostic: failure("data.api-redirect", `${options.source} redirects more than ${API_REDIRECTS} times.`).diagnostic };
}

/** The credential, when the config names one; a missing environment variable is one diagnostic that names it. */
function credential(options: ApiFetchOptions): { readonly credential?: { readonly header: string; readonly value: string }; readonly diagnostic?: Diagnostic } {
  const auth: ApiAuthConfig | undefined = options.pagination?.auth;
  if (auth === undefined) return {};
  const secret = options.env[auth.env];
  if (secret === undefined || secret === "") {
    return {
      diagnostic: {
        id: "data.api-auth",
        severity: "error",
        message: `Collection "${options.collection}" needs the environment variable ${auth.env}, which is unset or empty.`,
        help: `Set ${auth.env} before you run \`mizzen data fetch\`.`,
      },
    };
  }
  return { credential: { header: auth.header ?? "Authorization", value: `${auth.prefix ?? ""}${secret}` } };
}

/** The record array of one response, with the page number in every message. */
function recordsOf(response: { readonly value: unknown; readonly page: number; readonly path: string; readonly collection: string }): { readonly records?: readonly unknown[]; readonly diagnostic?: Diagnostic } {
  const value = valueAtPath(response.value, response.path);
  if (!Array.isArray(value)) {
    return {
      diagnostic: failure(
        "data.api-records",
        `Page ${response.page} of collection "${response.collection}" has no record array at "${response.path}".`,
        `Check \`records\` in mizzen.yml and the response of page ${response.page}.`,
      ).diagnostic,
    };
  }
  return { records: value };
}

/**
 * Reads every record of one API source. Pages are fetched in traversal order; the result holds them as one list in
 * that order. A duplicate id names both pages. The fetch stops at the first problem, before anything is stored.
 */
export async function fetchApiSource(options: ApiFetchOptions): Promise<ApiFetchResult> {
  const parsed = fetchableUrl(options.source, options.collection);
  if (parsed.url === undefined) return { diagnostic: parsed.diagnostic };
  const base = parsed.url;
  const pagination = options.pagination;
  const allowed = new Set<string>([base.origin]);
  for (const origin of pagination?.origins ?? []) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return failure("data.api-origin", `Collection "${options.collection}" names the allowed origin "${origin}", which is not a URL.`);
    }
    allowed.add(url.origin);
  }

  const auth = credential(options);
  if (auth.diagnostic !== undefined) return { diagnostic: auth.diagnostic };

  const maxPages = pagination?.maxPages ?? DEFAULT_API_MAX_PAGES;
  const maxBytes = pagination?.maxBytes ?? options.limits.bytes;
  const records: unknown[] = [];
  const pages: ApiPage[] = [];
  const seen = new Map<string, number>();
  const seenCursors = new Set<string>();
  const seenUrls = new Set<string>();
  let totalBytes = 0;
  let fetchedAt: string | undefined;
  const firstPage = pagination === undefined || pagination.mode === "cursor" || pagination.mode === "next"
    ? new URL(base.href)
    : pageUrl(base, pagination.mode, pagination.param ?? pagination.mode, pagination.start ?? (pagination.mode === "page" ? 1 : 0));
  let current = firstPage;
  let offset = pagination?.start ?? 0;

  for (;;) {
    const pageNumber = pages.length + 1;
    const response = await requestPage(current, options, allowed, maxBytes - totalBytes, maxBytes, auth.credential);
    if (response.diagnostic !== undefined) return { diagnostic: response.diagnostic };
    const responseUrl = response.url!;
    if (seenUrls.has(responseUrl)) {
      return failure("data.api-page-repeat", `Page ${pageNumber} of collection "${options.collection}" repeats ${responseUrl}, which was already read.`);
    }
    seenUrls.add(responseUrl);
    if (fetchedAt === undefined && response.fetchedAt !== undefined) fetchedAt = response.fetchedAt;

    const bytes = response.bytes!;
    totalBytes += bytes.byteLength;
    const hash = sha256(bytes);
    pages.push({ url: responseUrl, bytes: bytes.byteLength, sha256: hash });

    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(bytes));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return failure("data.api-invalid-json", `Page ${pageNumber} of collection "${options.collection}" is not valid JSON: ${detail}`);
    }
    const extracted = recordsOf({ value, page: pageNumber, path: options.records, collection: options.collection });
    if (extracted.records === undefined) return { diagnostic: extracted.diagnostic };
    const pageRecords = extracted.records;

    for (const record of pageRecords) {
      if (typeof record !== "object" || record === null || Array.isArray(record)) continue;
      const raw = (record as Record<string, unknown>)[options.idField];
      if (typeof raw !== "string" && typeof raw !== "number") continue;
      const id = String(raw);
      const first = seen.get(id);
      if (first !== undefined) {
        return failure("data.api-duplicate-id", `Record "${id}" of collection "${options.collection}" appears on pages ${first} and ${pageNumber}.`);
      }
      seen.set(id, pageNumber);
    }
    records.push(...pageRecords);

    if (totalBytes > options.limits.bytes) {
      return failure("data.api-source-too-large", `Collection "${options.collection}" reads ${totalBytes} bytes; the limit is ${options.limits.bytes}.`, `Raise collections.${options.collection}.limits.bytes, or split the API.`);
    }

    const mode = pagination?.mode;
    if (mode === undefined) break;
    if ((mode === "page" || mode === "offset") && pagination !== undefined) {
      if (pagination.stop === "short" && pagination.pageSize !== undefined && pageRecords.length < pagination.pageSize) break;
      if (pageRecords.length === 0) break;
    }

    let next: URL | undefined;
    if (mode === "page" && pagination !== undefined) {
      next = pageUrl(base, "page", pagination.param ?? "page", (pagination.start ?? 1) + pages.length);
    } else if (mode === "offset" && pagination !== undefined) {
      offset += pageRecords.length;
      next = pageUrl(base, "offset", pagination.param ?? "offset", offset);
    } else if (mode === "cursor" && pagination !== undefined) {
      const cursor = valueAtPath(value, pagination.cursor!);
      if (cursor === undefined || cursor === null || cursor === "") break;
      if (typeof cursor !== "string") {
        return failure("data.api-cursor", `Page ${pageNumber} of collection "${options.collection}" writes a cursor at "${pagination.cursor}" that is not a string.`);
      }
      if (seenCursors.has(cursor)) {
        return failure("data.api-cursor-repeat", `Collection "${options.collection}" received the cursor "${cursor}" twice; page ${pageNumber} repeats an earlier request.`);
      }
      seenCursors.add(cursor);
      next = pageUrl(base, "cursor", pagination.param ?? "cursor", cursor);
    } else if (mode === "next" && pagination !== undefined) {
      const target = valueAtPath(value, pagination.next!);
      if (target === undefined || target === null || target === "") break;
      if (typeof target !== "string") {
        return failure("data.api-next", `Page ${pageNumber} of collection "${options.collection}" writes a next-page URL at "${pagination.next}" that is not a string.`);
      }
      try {
        next = new URL(target, current);
      } catch {
        return failure("data.api-next", `Page ${pageNumber} of collection "${options.collection}" writes "${target}", which is not a URL.`);
      }
      if (!isFetchableUrl(next)) return failure("data.api-url", `Collection "${options.collection}" may not follow "${next.href}".`);
      if (!allowed.has(next.origin)) {
        return failure("data.api-origin", `Collection "${options.collection}" may not follow ${next.origin}; allowed: ${[...allowed].sort().join(", ")}.`, `Add the origin under collections.${options.collection}.pagination.origins.`);
      }
    }

    if (next === undefined) break;
    if (pages.length >= maxPages) {
      return failure("data.api-too-many-pages", `Collection "${options.collection}" read ${pages.length} pages; the limit is ${maxPages}.`, `Raise collections.${options.collection}.pagination.maxPages.`);
    }
    current = next;
  }

  const text = `${JSON.stringify(records, null, 2)}\n`;
  return {
    bytes: new TextEncoder().encode(text),
    pages,
    records: records.length,
    ...(fetchedAt === undefined ? {} : { fetchedAt }),
  };
}
