/**
 * A collection's raw data as it is published beside the pages: a JSON file that carries the snapshot, a CSV file, and a
 * checksum file naming the SHA-256 of both (of the CSV alone when the `collection-json` output is off). Fields a collection marks private are left out of every file, and a
 * collection with `raw: false` has none. Records keep source order, fields keep source order, and every file ends in
 * one line feed, so the same data always gives the same bytes.
 */
import type { Collection, CollectionConfig } from "../contracts/index.ts";
import { publicFields } from "./public.ts";
import { sha256 } from "./lock.ts";

/** The files of one collection's raw data. */
export interface RawFiles {
  readonly json: string;
  readonly csv: string;
  /** `sha256sum` format: the hash, two spaces, the file name. */
  readonly checksums: string;
}

/** The path of each raw file, relative to the output folder. */
export function rawPaths(name: string): { readonly json: string; readonly csv: string; readonly checksums: string } {
  return { json: `data/${name}.raw.json`, csv: `data/${name}.csv`, checksums: `data/${name}.sha256` };
}

/** True unless the collection turns its raw output off. */
export function rawEnabled(entry: CollectionConfig | undefined): boolean {
  return entry?.raw !== false;
}

function fieldsWithout(fields: Readonly<Record<string, unknown>>, hidden: ReadonlySet<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!hidden.has(key)) out[key] = value;
  }
  return out;
}

function cell(value: unknown): string {
  const text = value === undefined || value === null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Builds one collection's raw files, or `undefined` when its config turns them off. */
export function rawFiles(collection: Collection, entry: CollectionConfig | undefined, jsonWritten = true): RawFiles | undefined {
  if (!rawEnabled(entry)) return undefined;
  const hidden = new Set(entry?.raw === undefined || entry.raw === false ? [] : (entry.raw.private ?? []));
  const records = collection.records.map((record) => ({
    id: record.id,
    fields: fieldsWithout(publicFields(record.fields, entry?.public), hidden),
  }));

  const body = {
    collection: collection.name,
    ...(collection.snapshot === undefined ? {} : { snapshot: collection.snapshot }),
    records,
  };
  const json = `${JSON.stringify(body, null, 2)}\n`;

  const columns: string[] = [];
  for (const record of records) {
    for (const key of Object.keys(record.fields)) {
      if (key !== "id" && !columns.includes(key)) columns.push(key);
    }
  }
  const rows = [["id", ...columns].map(cell).join(",")];
  for (const record of records) {
    rows.push([record.id, ...columns.map((key) => record.fields[key])].map(cell).join(","));
  }
  const csv = `${rows.join("\n")}\n`;

  const paths = rawPaths(collection.name);
  const name = (path: string) => path.slice(path.lastIndexOf("/") + 1);
  // The checksum file names only the files the build writes.
  const checksums = `${sha256(csv)}  ${name(paths.csv)}\n${jsonWritten ? `${sha256(json)}  ${name(paths.json)}\n` : ""}`;
  return { json, csv, checksums };
}
