/**
 * Reads the shared network file and each public project's page list, for `mizzen network update` only. A build never
 * imports this unit. An address is an `https:` URL (or `http:` on a loopback host, for a local test server) or a path
 * on disk; the fetcher bounds the time, the size, and the redirects, and sends no header that names the site.
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Diagnostic } from "../contracts/index.ts";
import { sha256 } from "../data/lock.ts";
import { DEFAULT_MANIFEST, parseNetwork, type NetworkFile, type NetworkFileProject, type NetworkProblem } from "./file.ts";
import type { LockedPage, LockedProject, NetworkLock } from "./lock.ts";

/** How long one request may take. */
export const NETWORK_FETCH_TIMEOUT_MS = 30_000;
/** How many redirects one request may follow. */
export const NETWORK_FETCH_REDIRECTS = 5;
/** The most bytes one fetched file may hold. */
export const NETWORK_FETCH_MAX_BYTES = 5 * 1024 * 1024;

/** A `fetch` with the one shape this unit uses, so a test can point it at a local server. */
export type NetworkFetchLike = (url: string, init?: RequestInit) => Promise<Response>;

function isLoopback(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

/** True when `address` names a URL rather than a path. */
export function isUrl(address: string): boolean {
  return /^[a-z][a-z\d+.-]*:\/\//i.test(address);
}

/** Reads the bytes at a URL with a bounded time, size, and redirect count; a path is read from disk. */
export async function readAddress(address: string, root: string, fetcher: NetworkFetchLike): Promise<Uint8Array> {
  if (!isUrl(address)) return new Uint8Array(await readFile(resolve(root, address)));
  let current = address;
  for (let redirects = 0; redirects <= NETWORK_FETCH_REDIRECTS; redirects++) {
    const url = new URL(current);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url))) {
      throw new Error(`"${current}" is not an https URL`);
    }
    const response = await fetcher(current, {
      redirect: "manual",
      headers: { accept: "application/json, */*" },
      signal: AbortSignal.timeout(NETWORK_FETCH_TIMEOUT_MS),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location === null) throw new Error(`HTTP ${response.status} from ${current} names no location`);
      current = new URL(location, current).href;
      continue;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${current}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > NETWORK_FETCH_MAX_BYTES) throw new Error(`${address} is larger than the ${NETWORK_FETCH_MAX_BYTES} byte limit`);
    return bytes;
  }
  throw new Error(`${address} redirects more than ${NETWORK_FETCH_REDIRECTS} times`);
}

/** The address of a file published under a project: origin-relative for a URL source, beside the file for a path. */
export function projectAddress(source: string, root: string, path: string, file: string): string {
  if (isUrl(source)) return new URL(`/${path}/${file}`, source).href;
  return resolve(dirname(resolve(root, source)), path, file);
}

/** What {@link fetchNetwork} returns. */
export interface FetchedNetwork {
  readonly lock?: NetworkLock;
  readonly problems: readonly NetworkProblem[];
  /** Fetch and manifest problems, as one message each. */
  readonly errors: readonly string[];
}

/** The rendered-body hash and title of each page of a project's manifest, or an error text. */
function pagesOf(bytes: Uint8Array, project: NetworkFileProject, previous: LockedProject | undefined, accept: boolean): LockedPage[] | string {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return `the page list of "${project.id}" is not valid JSON`;
  }
  const list = (value as { pages?: unknown } | null)?.pages;
  if (!Array.isArray(list)) return `the page list of "${project.id}" has no \`pages\``;
  const base = `/${project.path}`;
  const before = new Map((previous?.manifest?.pages ?? []).map((page) => [page.path, page]));
  const pages: LockedPage[] = [];
  for (const entry of list as { url?: unknown; title?: unknown; hashes?: { html?: unknown } }[]) {
    if (typeof entry?.url !== "string" || typeof entry.title !== "string" || typeof entry.hashes?.html !== "string") {
      return `the page list of "${project.id}" has an entry without \`url\`, \`title\`, and \`hashes.html\``;
    }
    if (entry.url !== base && !entry.url.startsWith(`${base}/`)) {
      return `the page ${entry.url} of "${project.id}" is not under its path ${base}; its build must use that base`;
    }
    const path = entry.url.slice(base.length) || "/";
    const old = before.get(path);
    const hash = entry.hashes.html;
    const changed = old !== undefined && old.sha256 !== hash;
    const previousHash = changed ? old.sha256 : accept ? undefined : old?.previous;
    pages.push({ path, title: entry.title, sha256: hash, ...(previousHash === undefined ? {} : { previous: previousHash }) });
  }
  return pages;
}

/**
 * Reads the network file at `source` and the page list of every public project, and returns the lock they make.
 * Nothing is returned as a lock when the file has problems or any page list cannot be read, so a half-fetched network
 * never replaces a good lock. `previous` carries the earlier lock, so a page whose hash changed keeps the old hash in
 * `previous`, and `accept` clears those marks.
 */
export async function fetchNetwork(options: {
  readonly source: string;
  readonly project: string;
  readonly root: string;
  readonly fetch: NetworkFetchLike;
  readonly previous?: NetworkLock;
  readonly accept?: boolean;
}): Promise<FetchedNetwork> {
  const errors: string[] = [];
  let bytes: Uint8Array;
  try {
    bytes = await readAddress(options.source, options.root, options.fetch);
  } catch (err) {
    return { problems: [], errors: [`Cannot read the network file ${options.source}: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const parsed = parseNetwork(new TextDecoder().decode(bytes));
  const network: NetworkFile | undefined = parsed.network;
  if (parsed.problems.length > 0 || network === undefined) return { problems: parsed.problems, errors };
  if (!network.projects.some((project) => project.id === options.project)) {
    return {
      problems: [],
      errors: [`The network file does not list the project "${options.project}" that the site config names.`],
    };
  }

  const old = new Map((options.previous?.projects ?? []).map((project) => [project.id, project]));
  const projects: LockedProject[] = [];
  for (const project of network.projects) {
    const common = {
      id: project.id,
      path: project.path,
      title: project.title,
      public: project.public,
      ...(project.analytics === undefined ? {} : { analytics: project.analytics }),
      ...(project.search === undefined ? {} : { search: project.search }),
    };
    // A project that is not public is listed but never read: its page list stays out of the lock.
    if (!project.public) {
      projects.push(common);
      continue;
    }
    const url = projectAddress(options.source, options.root, project.path, project.manifest ?? DEFAULT_MANIFEST);
    let manifestBytes: Uint8Array;
    try {
      manifestBytes = await readAddress(url, options.root, options.fetch);
    } catch (err) {
      errors.push(`Cannot read the page list of "${project.id}" at ${url}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const pages = pagesOf(manifestBytes, project, old.get(project.id), options.accept === true);
    if (typeof pages === "string") {
      errors.push(`${pages} (${url}).`);
      continue;
    }
    projects.push({ ...common, manifest: { url, sha256: sha256(manifestBytes), pages } });
  }
  if (errors.length > 0) return { problems: [], errors };
  return { lock: { version: 1, source: options.source, sha256: sha256(bytes), projects }, problems: [], errors };
}

/** A finding as a `Diagnostic`, for callers that print through the diagnostics formatter. */
export function problemDiagnostic(file: string, problem: NetworkProblem): Diagnostic {
  return {
    id: problem.id,
    severity: "error",
    message: problem.message,
    pos: { file, line: problem.line, column: problem.column, endLine: problem.line, endColumn: problem.column },
  };
}
