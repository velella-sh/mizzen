/**
 * Site files as MCP resources: `llms.txt`, the generated `AGENTS.md`, and each page's Markdown twin. A resource is
 * only ever a file of the built site that this module lists, so a URI cannot name anything else.
 */
import { twinUrl } from "../outputs/twins.ts";
import { confine, McpError } from "./limits.ts";
import type { SiteState } from "./site.ts";

/** Resources per page of the list. */
export const RESOURCE_PAGE_SIZE = 100;
const PREFIX = "mizzen://site/";

export interface Resource {
  readonly uri: string;
  readonly name: string;
  readonly mimeType: string;
}

function underBase(url: string, base: string): string {
  if (base === "") return url;
  if (url === base || url.startsWith(`${base}/`)) return url.slice(base.length) || "/";
  return url;
}

/** Every listed resource, in a fixed order: `llms.txt`, `AGENTS.md`, then the twins by URL. */
async function listed(site: SiteState): Promise<readonly Resource[]> {
  const out: Resource[] = [];
  for (const name of ["llms.txt", "AGENTS.md"]) {
    const exists = await confine(site.out, name).then(() => true, () => false);
    if (exists) out.push({ uri: `${PREFIX}${name}`, name, mimeType: name.endsWith(".md") ? "text/markdown" : "text/plain" });
  }
  const base = site.site.config.base;
  for (const { page } of site.readablePages) {
    const twin = twinUrl(page.url);
    if (twin === undefined) continue;
    const path = underBase(twin, base).replace(/^\//, "");
    const exists = await confine(site.out, path).then(() => true, () => false);
    if (exists) out.push({ uri: `${PREFIX}${path}`, name: page.title, mimeType: "text/markdown" });
  }
  return out;
}

/** One page of the resource list; `nextCursor` is absent on the last page. */
export async function listResources(
  site: SiteState,
  cursor: string | undefined,
): Promise<{ readonly resources: readonly Resource[]; readonly nextCursor?: string }> {
  const all = await listed(site);
  const start = cursor === undefined ? 0 : Number(cursor);
  if (!Number.isInteger(start) || start < 0 || start > all.length) throw new McpError("bad-cursor", "The cursor is not one this server gave.");
  const end = start + RESOURCE_PAGE_SIZE;
  return { resources: all.slice(start, end), ...(end < all.length ? { nextCursor: String(end) } : {}) };
}

/** Reads one listed resource; a URI that is not listed, or that escapes the built site, is refused. */
export async function readResource(site: SiteState, uri: string): Promise<{ readonly uri: string; readonly mimeType: string; readonly text: string }> {
  if (!uri.startsWith(PREFIX)) throw new McpError("unknown-resource", `Unknown resource: ${uri}`);
  let path: string;
  try {
    path = decodeURIComponent(uri.slice(PREFIX.length));
  } catch {
    throw new McpError("unknown-resource", `Unknown resource: ${uri}`);
  }
  await confine(site.out, path); // refuses `..`, absolute paths, and symlinks that leave the build
  const resource = (await listed(site)).find((r) => r.uri === `${PREFIX}${path}`);
  if (resource === undefined) throw new McpError("unknown-resource", `Unknown resource: ${uri}`);
  return { uri: resource.uri, mimeType: resource.mimeType, text: await site.readBuilt(path) };
}
