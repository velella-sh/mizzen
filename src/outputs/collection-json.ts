/**
 * The `collection-json` output: `data/<collection>.json`, one small index per collection, so an agent or a tool learns
 * every record's id and URL without reading the data file or the HTML.
 *
 * A record without a main page is left out, and a record with pages in several languages points at the default
 * language's page. Beside each index it writes `data/<collection>.raw.json`: every record's fields and the collection's
 * snapshot, without the fields `raw.private` lists, and nothing when `raw` is `false`. Every record's fields live in its own page JSON, which this file links to; copying them here would
 * duplicate the same data once per file. Files come back sorted by path, records by id.
 */
import type { Site } from "../contracts/content.ts";
import type { Output, OutputFile } from "../contracts/output.ts";
import { rawFiles, rawPaths } from "../data/raw.ts";
import { jsonUrl } from "./page-json.ts";
import { indexRecords } from "./search-shared.ts";

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** One collection index: the collection's name and each record's identity, URL, and page JSON address. */
interface CollectionJson {
  readonly collection: string;
  readonly records: readonly {
    readonly id: string;
    readonly url: string;
    /** The page JSON's URL, including `base`; null when the `page-json` output is off or the URL names no page. */
    readonly page: string | null;
  }[];
}

/** Writes one JSON index per declared collection. */
export const collectionJson: Output = {
  name: "collection-json",
  async run(site: Site): Promise<readonly OutputFile[]> {
    // A page JSON address is only worth publishing when the `page-json` output writes the file it names.
    const pageJsonOn = site.config.outputs["page-json"] !== false;
    const files: OutputFile[] = [];
    for (const name of Object.keys(site.config.collections)) {
      const records = indexRecords(site, name)
        .map(({ record, page }) => ({
          id: record.id,
          url: page.url,
          page: pageJsonOn && page.kind === "doc" ? (jsonUrl(page.url) ?? null) : null,
        }))
        .sort((a, b) => byCodePoint(a.id, b.id));
      const body: CollectionJson = { collection: name, records };
      files.push({ path: `data/${name}.json`, contents: `${JSON.stringify(body, null, 2)}\n` });
      // The raw data, with the collection's snapshot, beside the index; a collection with `raw: false` gets none.
      const collection = site.collections[name];
      const raw = collection === undefined ? undefined : rawFiles(collection, site.config.collections[name]);
      if (raw !== undefined) files.push({ path: rawPaths(name).json, contents: raw.json });
    }
    return files.sort((a, b) => byCodePoint(a.path, b.path));
  },
};
