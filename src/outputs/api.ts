/**
 * The `api` output: the versioned static data API under `api/<version>/`. A site without the `api` key writes nothing,
 * and a collection the key does not name is never published.
 *
 * `index.json` is the entry point: the version, and for each collection its field list, record count, links, and snapshot.
 * It holds no records. `<collection>.json` holds every published record ordered by id, and `<collection>.ndjson` the same
 * records one per line. `<collection>/<id>.json` holds one record: its fields, its page address, and the addresses it had
 * before. The file is named by the id, so a renamed record keeps its file while its page address changes. Files come back sorted by path and every file is plain deterministic JSON ending in one line feed.
 */
import type { Site } from "../contracts/content.ts";
import type { Output, OutputContext, OutputFile } from "../contracts/output.ts";
import { unsafeIdReason } from "../api/ids.ts";
import { publishedSchema } from "../api/schemas.ts";
import { openApiDocument } from "../api/openapi.ts";
import { apiVersions, type ApiVersion } from "../api/versions.ts";
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
function indexEntry(site: Site, collection: ApiCollection, hasSchema: boolean): Record<string, unknown> {
  return {
    name: collection.name,
    count: collection.records.length,
    fields: collection.fields,
    json: apiUrl(site, `${collection.name}.json`),
    record: apiUrl(site, `${collection.name}/{id}.json`),
    ndjson: apiUrl(site, `${collection.name}.ndjson`),
    schema: hasSchema ? apiUrl(site, `schemas/${collection.name}.json`) : null,
    snapshot: collection.snapshot,
  };
}

/** The files of one version: the site seen as if it published only that version. */
async function versionFiles(whole: Site, version: ApiVersion, ctx: OutputContext): Promise<OutputFile[]> {
  const site: Site = { ...whole, config: { ...whole.config, api: { version: version.version, collections: version.collections } } };
  const collections = apiCollections(site, (diagnostic) => ctx.report(diagnostic));
  const dir = apiDir(site);
  const files: OutputFile[] = [];
  // A collection without a schema publishes none, and the index says so with null.
  const schemas = new Map<string, Record<string, unknown>>();
  for (const collection of collections) {
    const schema = publishedSchema(site, ctx.build?.root, collection, (diagnostic) => ctx.report(diagnostic));
    if (schema === undefined) continue;
    schemas.set(collection.name, schema);
    files.push({ path: `${dir}/schemas/${collection.name}.json`, contents: jsonFile(schema) });
  }
  files.push({ path: `${dir}/openapi.json`, contents: jsonFile(openApiDocument(site, collections, schemas)) });
  files.push({
    path: `${dir}/index.json`,
    contents: jsonFile({
      version: version.version,
      status: version.status,
      sunset: version.sunset,
      successor: version.successor,
      collections: collections.map((collection) => indexEntry(site, collection, schemas.has(collection.name))),
    }),
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
  for (const collection of collections) {
    // A record file is named by the record id, which never changes, and never by the page address.
    const taken = new Map<string, string>();
    for (const record of collection.records) {
      const reason = unsafeIdReason(record.id);
      if (reason !== undefined) {
        ctx.report({
          id: "api.unsafe-id",
          severity: "error",
          message: `The record id "${record.id}" of "${collection.name}" cannot be an API file name: ${reason}.`,
          help: "Change the record's id, or leave the collection out of `api.collections`.",
        });
        continue;
      }
      // Two ids that differ only in case would share one file on a case-insensitive host.
      const folded = record.id.toLowerCase();
      const other = taken.get(folded);
      if (other !== undefined) {
        ctx.report({
          id: "api.id-collision",
          severity: "error",
          message: `The record ids "${other}" and "${record.id}" of "${collection.name}" differ only in case, so their API files would collide on some hosts.`,
          help: "Give one of the records another id.",
        });
        continue;
      }
      taken.set(folded, record.id);
      files.push({
        path: `${dir}/${collection.name}/${record.id}.json`,
        contents: jsonFile({
          collection: collection.name,
          [collection.idKey]: record.id,
          fields: record.fields,
          url: record.url,
          previousUrls: record.previousUrls,
        }),
      });
    }
  }
  return files;
}

/** Writes the API files. */
export const api: Output = {
  name: "api",
  async run(site: Site, ctx: OutputContext): Promise<readonly OutputFile[]> {
    const files: OutputFile[] = [];
    for (const version of apiVersions(site, (diagnostic) => ctx.report(diagnostic))) files.push(...(await versionFiles(site, version, ctx)));
    return files.sort((a, b) => byCodePoint(a.path, b.path));
  },
};
