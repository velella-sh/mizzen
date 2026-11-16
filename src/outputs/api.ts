/**
 * The `api` output: the versioned static data API under `api/<version>/`. A site without the `api` key writes nothing,
 * and a collection the key does not name is never published.
 *
 * `index.json` is the entry point: the version, and for each collection its field list, record count, links, and snapshot.
 * It holds no records. `<collection>.json` holds every published record ordered by id, and `<collection>.ndjson` the same
 * records one per line. Files come back sorted by path and every file is plain deterministic JSON ending in one line feed.
 */
import type { Site } from "../contracts/content.ts";
import type { Output, OutputContext, OutputFile } from "../contracts/output.ts";
import { apiCollections, apiDir, apiUrl, byCodePoint, type ApiCollection, type ApiRecord } from "../api/model.ts";

/** Serializes a file body: two-space indent and one final line feed. */
export function jsonFile(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** One record as the collection files write it: the id under its key, then the published fields. */
function recordBody(collection: ApiCollection, record: ApiRecord): Record<string, unknown> {
  return { [collection.idKey]: record.id, ...record.fields };
}

/** The index file's entry for one collection. */
function indexEntry(site: Site, collection: ApiCollection): Record<string, unknown> {
  return {
    name: collection.name,
    count: collection.records.length,
    fields: collection.fields,
    json: apiUrl(site, `${collection.name}.json`),
    ndjson: apiUrl(site, `${collection.name}.ndjson`),
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
      contents: jsonFile({ version: site.config.api.version, collections: collections.map((collection) => indexEntry(site, collection)) }),
    });
    for (const collection of collections) {
      const records = collection.records.map((record) => recordBody(collection, record));
      files.push({
        path: `${dir}/${collection.name}.json`,
        contents: jsonFile({ collection: collection.name, count: records.length, records }),
      });
      // One record per line, for a reader that streams a large collection.
      files.push({
        path: `${dir}/${collection.name}.ndjson`,
        contents: records.map((record) => `${JSON.stringify(record)}\n`).join(""),
      });
    }
    return files.sort((a, b) => byCodePoint(a.path, b.path));
  },
};
