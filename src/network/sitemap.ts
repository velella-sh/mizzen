/**
 * `mizzen network sitemap`: the organization site's sitemap index. It points to the root site's own sitemap files and
 * each public project's own `sitemap.xml`, and never merges their URLs into one file. `robots.txt` names the index and
 * keeps the root site's other rules. A project that is not public is left out. Output is canonical: sorted by URL,
 * without duplicates or the index itself, LF, no timestamp.
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { robotsText } from "../outputs/robots.ts";
import { NETWORK_LOCK_FILE, readNetworkLock } from "./lock.ts";
import { publicProjects } from "./visibility.ts";

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>';

/** Escapes the five characters XML reserves. */
function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** A project's sitemap below `origin`: its path as URL segments, then `/sitemap.xml`. */
function projectSitemap(origin: string, path: string): string {
  const segments = path.split("/").filter((segment) => segment !== "");
  return segments.length === 0 ? `${origin}/sitemap.xml` : `${origin}/${segments.join("/")}/sitemap.xml`;
}

/** The `<loc>` values of a sitemap index. */
function locsOf(index: string): string[] {
  return [...index.matchAll(/<loc>([^<]*)<\/loc>/g)].map((match) => match[1]!);
}

/**
 * The text of the sitemap index: `rootMaps` first, then each public project's sitemap, sorted by URL. A project path
 * with a leading or trailing slash is one address, a repeated address is written once, and the index never lists itself.
 */
export function sitemapIndexText(
  origin: string,
  projects: readonly { readonly path: string; readonly public: boolean }[],
  rootMaps: readonly string[] = [],
): string {
  const self = `${origin}/sitemap.xml`;
  const locs = [...rootMaps, ...publicProjects(projects).map((project) => projectSitemap(origin, project.path))]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .filter((loc, i, all) => loc !== self && loc !== all[i - 1])
    .map((loc) => `  <sitemap>\n    <loc>${escapeXml(loc)}</loc>\n  </sitemap>\n`);
  return `${XML_HEAD}\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${locs.join("")}</sitemapindex>\n`;
}

/**
 * Writes `robots.txt` with the index named, keeping the rules the root site's build wrote. An existing `Sitemap:` line
 * is replaced, never duplicated.
 */
async function writeRobots(out: string, index: string): Promise<void> {
  const path = join(out, "robots.txt");
  const existing = await readFile(path, "utf8").catch(() => undefined);
  const kept = (existing ?? robotsText(undefined))
    .split("\n")
    .filter((line) => !/^\s*sitemap\s*:/i.test(line))
    .join("\n")
    .replace(/\n+$/, "");
  await writeFile(path, `${kept}\n\nSitemap: ${index}\n`);
}

/** What {@link writeNetworkSitemap} returns. */
export interface NetworkSitemapResult {
  readonly code: 0 | 1 | 2;
  readonly lines: readonly string[];
  readonly errors: readonly string[];
}

/** Reads the lock at `input` (a folder or the lock file) and writes `sitemap.xml` and `robots.txt` into `out`. */
export async function writeNetworkSitemap(options: { readonly input: string; readonly url: string | undefined; readonly out: string }): Promise<NetworkSitemapResult> {
  const isDir = await stat(options.input).then((s) => s.isDirectory(), () => undefined);
  if (isDir === undefined) return { code: 2, lines: [], errors: [`Cannot read ${options.input}`] };
  const root = isDir ? options.input : join(options.input, "..");
  const read = isDir || options.input.endsWith(NETWORK_LOCK_FILE)
    ? await readNetworkLock(root)
    : { diagnostics: [{ id: "network.lock-invalid", severity: "error" as const, message: `${options.input} is not a ${NETWORK_LOCK_FILE}` }] };
  if (read.lock === undefined) return { code: 1, lines: [], errors: read.diagnostics.map((d) => `${d.id}: ${d.message}`) };
  let origin: string;
  try {
    origin = new URL(options.url ?? read.lock.source).origin;
  } catch {
    return { code: 2, lines: [], errors: ["The organization's origin is unknown: pass --url https://example.org"] };
  }
  if (options.url === undefined && !/^https?:/.test(read.lock.source)) {
    return { code: 2, lines: [], errors: ["The lock's source is a path, so pass the organization's origin with --url https://example.org"] };
  }
  await mkdir(options.out, { recursive: true });
  const target = join(options.out, "sitemap.xml");
  const previous = await readFile(target, "utf8").catch(() => undefined);
  // The root site is built first. Its one-file sitemap moves to sitemap-pages.xml with its bytes unchanged; a split
  // sitemap is already an index, so its child files are listed as they are, also on a second run over this index.
  let rootMaps: readonly string[] = [];
  if (previous !== undefined && previous.includes("<sitemapindex")) {
    const prefix = `${origin}/sitemap`;
    rootMaps = locsOf(previous).filter((loc) => loc.startsWith(prefix) && !loc.slice(prefix.length).includes("/"));
  } else if (previous !== undefined && previous.includes("<urlset")) {
    await writeFile(join(options.out, "sitemap-pages.xml"), previous);
    rootMaps = [`${origin}/sitemap-pages.xml`];
  }
  await writeFile(target, sitemapIndexText(origin, read.lock.projects, rootMaps));
  await writeRobots(options.out, `${origin}/sitemap.xml`);
  const count = publicProjects(read.lock.projects).length;
  return { code: 0, lines: [`wrote sitemap.xml (${count} project${count === 1 ? "" : "s"}) and robots.txt to ${options.out}`], errors: [] };
}
