/**
 * The `headers` output: a `_headers` file with CORS and cache rules for `/api/*`, written only when the config sets
 * `api.headers: true`. It is for hosts that read such a file; whether a host does is the host's own behavior, which the
 * docs name and this unit never claims. A `_headers` file the site already has is never replaced: the site's copy is
 * copied byte for byte and the engine's is skipped, and a file found in the source folder here keeps this unit from
 * writing one even when discovery did not list it as an asset.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Site } from "../contracts/content.ts";
import type { Output, OutputContext, OutputFile } from "../contracts/output.ts";

/** The file's name at the root of the output folder. */
export const HEADERS_FILE = "_headers";

/** The text of the file for a site: rules for every path under `<base>/api/`. */
export function headersText(site: Site): string {
  const base = site.config.base.replace(/\/+$/, "");
  return [
    `${base}/api/*`,
    "  Access-Control-Allow-Origin: *",
    "  Access-Control-Allow-Methods: GET, HEAD, OPTIONS",
    "  Cache-Control: public, max-age=300",
    "",
  ].join("\n");
}

export const headers: Output = {
  name: "headers",
  async run(site: Site, ctx: OutputContext): Promise<readonly OutputFile[]> {
    if (site.config.api?.headers !== true) return [];
    const root = ctx.build?.root;
    if (root !== undefined && existsSync(resolve(root, site.config.source, HEADERS_FILE))) return [];
    return [{ path: HEADERS_FILE, contents: headersText(site) }];
  },
};
