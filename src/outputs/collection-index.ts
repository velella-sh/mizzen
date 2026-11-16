import { gzipSync } from "node:zlib";
import type { DataRecord, Site } from "../contracts/index.ts";
import type { Output, OutputContext, OutputFile } from "../contracts/output.ts";
import { localizeFields } from "../data/record-context.ts";
import { byCodePoint, indexRecords } from "./search-shared.ts";

/** The largest chunk, in bytes, when a collection does not set `index.bytes`. */
export const DEFAULT_INDEX_BYTES = 100_000;

/** A value a column may hold: one scalar, a list of scalars, or `null` when the field is missing. */
type Scalar = string | number | boolean;
type Cell = Scalar | readonly Scalar[] | null;

/** One collection's compact index: columns once, then one array per record. */
interface IndexBody {
  readonly collection: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly Cell[])[];
}

/** A collection's index after splitting: the head file and its numbered chunks. */
interface SplitIndex {
  /** Chunks of rows, each serialized as its own `IndexBody`. */
  readonly chunks: readonly string[];
}

/** A scalar as the index writes it, or `undefined` for an object, a list, or `null`. */
function scalarOf(value: unknown): Scalar | undefined {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : undefined;
}

/** The value one column holds, from the page's language and with a declared date in its normalized form. */
function cellOf(record: DataRecord, fields: Readonly<Record<string, unknown>>, field: string): Cell {
  const normalized = record.normalizedDates?.[field];
  if (normalized !== undefined) return normalized;
  const value = fields[field];
  if (Array.isArray(value)) {
    return value.map(scalarOf).filter((item): item is Scalar => item !== undefined);
  }
  return scalarOf(value) ?? null;
}

/** Splits rows by the bytes they add to the JSON, never by their count, so one chunk fits the budget when it can. */
function splitRows(collection: string, columns: readonly string[], rows: readonly (readonly Cell[])[], budget: number): SplitIndex {
  const chunks: string[] = [];
  let current: (readonly Cell[])[] = [];
  let bytes = Buffer.byteLength(JSON.stringify({ collection, columns, rows: [] }));
  for (const row of rows) {
    const added = Buffer.byteLength(JSON.stringify(row)) + (current.length === 0 ? 0 : 1);
    if (current.length > 0 && bytes + added > budget) {
      chunks.push(JSON.stringify({ collection, columns, rows: current }));
      current = [];
      bytes = Buffer.byteLength(JSON.stringify({ collection, columns, rows: [] }));
    }
    current.push(row);
    bytes += current.length === 1 ? Buffer.byteLength(JSON.stringify(row)) : added;
  }
  if (current.length > 0 || chunks.length === 0) {
    chunks.push(JSON.stringify({ collection, columns, rows: current }));
  }
  return { chunks };
}

/** Reports the written and gzipped size of one index file, so the build summary carries the budget number. */
function reportSize(ctx: OutputContext, path: string, text: string): void {
  ctx.report({
    id: "collection-index.size",
    severity: "info",
    message: `${path}: ${Buffer.byteLength(text)} bytes, ${gzipSync(Buffer.from(text)).length} bytes gzipped.`,
  });
}

/**
 * Writes `data/<collection>.index.json` for every collection that declares `index`: a column layout, so each field
 * name is written once and every row is an array of values, with the record's page URL as the last column. A record
 * without a main page is left out, and a record with pages in several languages uses the default language's URL.
 *
 * A file larger than `index.bytes` is split into numbered chunks under the same folder, and the head file lists them
 * under `chunks` in order. The head file itself is the whole index when it fits. Files are written sorted by path, and
 * the gzipped size of every file is reported.
 */
export const collectionIndex: Output = {
  name: "collection-index",
  async run(site: Site, ctx: OutputContext): Promise<readonly OutputFile[]> {
    const files: OutputFile[] = [];
    for (const name of Object.keys(site.config.collections)) {
      const entry = site.config.collections[name]?.index;
      if (entry === undefined) continue;
      const columns = [...entry.fields.filter((field) => field !== "url"), "url"];
      const rows = indexRecords(site, name).map(({ record, page }) => {
        const fields = localizeFields(record.fields, page.lang, site.config.lang).fields;
        return [
          ...entry.fields.filter((field) => field !== "url").map((field) => cellOf(record, fields, field)),
          page.url,
        ];
      });
      const head = `data/${name}.index.json`;
      const body: IndexBody = { collection: name, columns, rows };
      const text = JSON.stringify(body);
      if (Buffer.byteLength(text) <= (entry.bytes ?? DEFAULT_INDEX_BYTES)) {
        files.push({ path: head, contents: text });
        reportSize(ctx, head, text);
        continue;
      }
      const split = splitRows(name, columns, rows, entry.bytes ?? DEFAULT_INDEX_BYTES);
      const chunks = split.chunks.map((chunk, index) => {
        const path = `data/${name}.index.${index + 1}.json`;
        reportSize(ctx, path, chunk);
        return { path, contents: chunk };
      });
      const listing = JSON.stringify({ collection: name, columns, chunks: chunks.map((chunk) => chunk.path) });
      files.push({ path: head, contents: listing }, ...chunks);
      reportSize(ctx, head, listing);
    }
    return files.sort((a, b) => byCodePoint(a.path, b.path));
  },
};
