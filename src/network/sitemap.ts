/**
 * `mizzen network sitemap`: the organization site's sitemap index. It points to each public project's own
 * `sitemap.xml` and never merges their URLs into one file. `robots.txt` names the index. A project that is not public
 * is left out. Output is canonical: sorted by path, LF, no timestamp.
 */
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { robotsText } from "../outputs/robots.ts";
import { NETWORK_LOCK_FILE, readNetworkLock } from "./lock.ts";
import { publicProjects } from "./visibility.ts";

/** Escapes the five characters XML reserves. */
function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** The text of the sitemap index for `origin` and the given projects, public ones only, sorted by path. */
export function sitemapIndexText(origin: string, projects: readonly { readonly path: string; readonly public: boolean }[]): string {
  const locs = publicProjects(projects)
    .map((project) => project.path)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((path) => `  <sitemap>\n    <loc>${escapeXml(`${origin}/${path}/sitemap.xml`)}</loc>\n  </sitemap>\n`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${locs.join("")}</sitemapindex>\n`;
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
  await writeFile(join(options.out, "sitemap.xml"), sitemapIndexText(origin, read.lock.projects));
  await writeFile(join(options.out, "robots.txt"), robotsText(`${origin}/sitemap.xml`));
  const count = publicProjects(read.lock.projects).length;
  return { code: 0, lines: [`wrote sitemap.xml (${count} project${count === 1 ? "" : "s"}) and robots.txt to ${options.out}`], errors: [] };
}
