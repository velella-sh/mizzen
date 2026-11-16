/**
 * The `api` output: the versioned static data API under `api/<version>/`. A site without the `api` key writes nothing,
 * and a collection the key does not name is never published.
 *
 * `index.json` is the entry point: the version, and for each collection its field list, record count, and snapshot. It
 * holds no records. Files come back sorted by path and every file is plain deterministic JSON ending in one line feed.
 */
import type { Site } from "../contracts/content.ts";
import type { Output, OutputContext, OutputFile } from "../contracts/output.ts";
import { apiCollections, apiDir, byCodePoint, type ApiCollection } from "../api/model.ts";

/** Serializes a file body: two-space indent and one final line feed. */
export function jsonFile(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** The index file's entry for one collection. */
function indexEntry(collection: ApiCollection): Record<string, unknown> {
  return {
    name: collection.name,
    count: collection.records.length,
    fields: collection.fields,
    snapshot: collection.snapshot,
  };
}

/** Writes the API files. */
export const api: Output = {
  name: "api",
  async run(site: Site, ctx: OutputContext): Promise<readonly OutputFile[]> {
    if (site.config.api === undefined) return [];
    const collections = apiCollections(site, (diagnostic) => ctx.report(diagnostic));
    const dir = apiDir(site);
    const files: OutputFile[] = [];
    files.push({
      path: `${dir}/index.json`,
      contents: jsonFile({ version: site.config.api.version, collections: collections.map(indexEntry) }),
    });
    return files.sort((a, b) => byCodePoint(a.path, b.path));
  },
};
