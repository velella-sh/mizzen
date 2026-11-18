/**
 * What the data API publishes, read from the site model: for each collection the config names, its published fields
 * and its records, ordered by id. The outputs and the checks work from this shape, so no file decides for itself which
 * record or field is public.
 */
import type { CollectionSnapshot, Diagnostic, Site } from "../contracts/index.ts";
import { lifecycleOf, listedForMachines } from "../data/lifecycle.ts";
import { isPublicReference } from "../data/public.ts";
import { indexRecords } from "../outputs/search-shared.ts";

/** One published record: its id and only the fields the config lists. */
export interface ApiRecord {
  readonly id: string;
  /** The published fields in the order the config lists them; a field the record lacks is absent. */
  readonly fields: Readonly<Record<string, unknown>>;
  /** The URL of the record's main page including `base`, or `null` when the record has no page. */
  readonly url: string | null;
  /** Earlier URLs of the record page, oldest first. */
  readonly previousUrls: readonly string[];
}

/** One published collection. */
export interface ApiCollection {
  readonly name: string;
  /** The key the id is written under. */
  readonly idKey: string;
  /** The published field names, as the config lists them. */
  readonly fields: readonly string[];
  /** Records ordered by id, by code point. */
  readonly records: readonly ApiRecord[];
  /** The collection's recorded snapshot, or `null` when the lock holds none. */
  readonly snapshot: CollectionSnapshot | null;
  /** True when the collection names a JSON Schema. */
  readonly hasSchema: boolean;
}

/** Compares by code point, never by locale. */
export function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The folder of one API version under the output folder: `api/v1`. */
export function apiDir(site: Site): string {
  return `api/${site.config.api?.version ?? "v1"}`;
}

/** The URL of a file under the API, including `base`: `/docs/api/v1/index.json`. */
export function apiUrl(site: Site, path: string): string {
  return `${site.config.base.replace(/\/+$/, "")}/${apiDir(site)}/${path}`;
}

/**
 * The collections the API publishes, sorted by name. A collection the config names but the site lacks is left out (the
 * config check already reports it). A published field that no record has, or an id key that is also a published field,
 * is reported as an error through `report`.
 */
export function apiCollections(site: Site, report: (diagnostic: Diagnostic) => void = () => {}): readonly ApiCollection[] {
  const api = site.config.api;
  if (api === undefined) return [];
  const out: ApiCollection[] = [];
  for (const name of Object.keys(api.collections).sort(byCodePoint)) {
    const entry = api.collections[name]!;
    const collection = site.collections[name];
    if (collection === undefined) continue;
    const idKey = entry.id ?? "id";
    if (entry.fields.includes(idKey)) {
      report({
        id: "api.id-key-conflict",
        severity: "error",
        message: `The API collection "${name}" publishes a field called "${idKey}", which is also the key its record id is written under.`,
        help: `Remove "${idKey}" from \`api.collections.${name}.fields\`, or set \`api.collections.${name}.id\` to another key.`,
      });
    }
    if (collection.records.length > 0) {
      for (const field of entry.fields) {
        if (collection.records.some((record) => Object.hasOwn(record.fields, field))) continue;
        report({
          id: "api.unknown-field",
          severity: "error",
          message: `The API publishes the field "${field}" of "${name}", which no record has.`,
          help: `Check \`api.collections.${name}.fields\` in mizzen.yml.`,
        });
      }
    }
    const lifecycle = site.config.collections[name]?.lifecycle;
    const policy = site.config.collections[name]?.public;
    const published = entry.fields.filter((field) => isPublicReference(policy, field));
    const pages = new Map(indexRecords(site, name).map(({ record, page }) => [record.id, page] as const));
    const records = collection.records
      .filter((record) => listedForMachines(lifecycleOf(record.fields, lifecycle)))
      .map((record): ApiRecord => {
        const fields: Record<string, unknown> = {};
        for (const field of published) {
          if (Object.hasOwn(record.fields, field)) fields[field] = record.fields[field];
        }
        const page = pages.get(record.id);
        return { id: record.id, fields, url: page?.url ?? null, previousUrls: [...(page?.record?.previousUrls ?? [])] };
      })
      .sort((a, b) => byCodePoint(a.id, b.id));
    out.push({
      name,
      idKey,
      fields: [...published],
      records,
      snapshot: collection.snapshot ?? null,
      hasSchema: site.config.collections[name]?.schema !== undefined,
    });
  }
  return out;
}
