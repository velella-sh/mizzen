/**
 * The `collection-csv` output: `data/<collection>.csv`, every record of a collection as one CSV row, and
 * `data/<collection>.sha256`, the SHA-256 of the CSV and of the raw JSON that `collection-json` writes beside it. Fields
 * the collection marks `raw.private` are left out, and a collection with `raw: false` writes neither file. Files come
 * back sorted by path.
 */
import type { Site } from "../contracts/content.ts";
import type { Output, OutputFile } from "../contracts/output.ts";
import { rawFiles, rawPaths } from "../data/raw.ts";

/** Writes one CSV and one checksum file per collection that publishes raw data. */
export const collectionCsv: Output = {
  name: "collection-csv",
  async run(site: Site): Promise<readonly OutputFile[]> {
    const jsonWritten = site.config.outputs["collection-json"] !== false;
    const files: OutputFile[] = [];
    for (const name of Object.keys(site.config.collections)) {
      const collection = site.collections[name];
      const raw = collection === undefined ? undefined : rawFiles(collection, site.config.collections[name], jsonWritten);
      if (raw === undefined) continue;
      const paths = rawPaths(name);
      files.push({ path: paths.csv, contents: raw.csv }, { path: paths.checksums, contents: raw.checksums });
    }
    return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  },
};
