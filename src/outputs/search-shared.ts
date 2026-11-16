/**
 * Shared reading of a collection's search settings, used by the Pagefind index and the facets file. This file exports
 * no output, so the pipeline skips it.
 */
import type {
  CollectionConfig,
  CollectionSearchConfig,
  DataRecord,
  Diagnostic,
  Page,
  Site,
} from "../contracts/index.ts";
import { localizeFields } from "../data/record-context.ts";

/** A filter with more distinct values than this is free text, not a facet. */
export const MAX_FILTER_VALUES = 100;

/** A sort field with a longer value than this is not short text. */
export const MAX_SORT_TEXT = 100;

/** The query parameter names of the search results page, shared by `opensearch.xml` and `search-facets.json`. */
export const SEARCH_QUERY = {
  /** The search text. */
  text: "q",
  /** A filter, with `{field}` replaced by the filter's name. */
  filter: "filter.{field}",
  /** The field results are ordered by. */
  sort: "sort",
  /** `asc` or `desc`. */
  order: "order",
} as const;

/**
 * The scope of a search in a site that is part of a network: the parameter that carries it and its two values.
 * `project` searches this project's index only, `all` also searches the other public projects' indexes. The
 * theme reads `pagefind-network.json` to know which indexes `all` adds; a site outside a network has no scope.
 */
export const SEARCH_SCOPE = { parameter: "scope", project: "project", all: "all" } as const;

/** Compares by code point, never by locale. */
export function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** One record page and the fields search reads from it. */
export interface SearchableRecord {
  /** The record page. */
  readonly page: Page;
  /** The source record, for its normalized dates and position. */
  readonly record: DataRecord;
  /** The collection's name. */
  readonly collection: string;
  /** The record's fields in the page's language. */
  readonly fields: Readonly<Record<string, unknown>>;
  /** The collection's search settings, empty when it sets none. */
  readonly config: CollectionSearchConfig;
}

/** The record a page was built from, in the page's language, or `undefined` for a non-record page or view. */
function recordOf(site: Site, page: Page): SearchableRecord | undefined {
  const identity = page.record;
  if (identity === undefined || identity.view !== undefined) return undefined;
  const collection = site.collections[identity.collection];
  if (collection === undefined) return undefined;
  const record = collection.records.find((candidate) => candidate.id === identity.id);
  if (record === undefined) return undefined;
  return {
    page,
    record,
    collection: identity.collection,
    fields: localizeFields(record.fields, page.lang, site.config.lang).fields,
    config: site.config.collections[identity.collection]?.search ?? {},
  };
}

/**
 * Every record page the index keeps: a document page with a record, not a named view, not left out by the page's front
 * matter, and not left out by the record's own `search: false` field. Pages keep the model's URL order.
 */
export function searchableRecords(site: Site): readonly SearchableRecord[] {
  const records: SearchableRecord[] = [];
  for (const page of site.pages) {
    if (page.kind !== "doc" || page.frontMatter.search === false) continue;
    const record = recordOf(site, page);
    if (record === undefined || record.fields.search === false) continue;
    records.push(record);
  }
  return records;
}

/** A value as one string, or `undefined` when it is not a scalar. */
export function textOf(value: unknown): string | undefined {
  if (typeof value === "string") return value === "" ? undefined : value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return undefined;
}

/** A value as its filter and metadata values: a list gives one value per item, and other non-scalars give none. */
export function valuesOf(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    const values: string[] = [];
    for (const item of value) {
      const text = textOf(item);
      if (text !== undefined) values.push(text);
    }
    return values;
  }
  const text = textOf(value);
  return text === undefined ? [] : [text];
}

/** A filter field and how many records hold each of its values, sorted by code point. */
export interface FilterCounts {
  /** The field's name, or `collection` for the collection itself. */
  readonly field: string;
  /** Values in code-point order, each with the number of records that hold it. */
  readonly values: Readonly<Record<string, number>>;
}

/** The filters a site writes: one per declared field with a bounded value set, always plus the collection name. */
export interface FilterPlan {
  /** The values of the `collection` filter, sorted by code point. */
  readonly collection: Readonly<Record<string, number>>;
  /** Declared fields, sorted by name, with the values of every collection that declares them. */
  readonly fields: readonly FilterCounts[];
  /** Declared fields left out because they have too many distinct values, keyed by collection. */
  readonly skipped: Readonly<Record<string, readonly string[]>>;
}

/** A counts map with no prototype, so a value named `__proto__` or `constructor` is an ordinary key. */
function countsMap(): Record<string, number> {
  return Object.create(null) as Record<string, number>;
}

/** Adds one value once per record, so a list with a repeated value counts that record once. */
function countValues(records: readonly SearchableRecord[], field: string): Record<string, number> {
  const counts = countsMap();
  for (const record of records) {
    const values = field === "collection" ? [record.collection] : valuesOf(record.fields[field]);
    for (const value of new Set(values)) counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

/** Adds `source` into `target`, keeping values in code-point order. */
function mergeCounts(target: Record<string, number>, source: Readonly<Record<string, number>>): void {
  for (const [value, count] of Object.entries(source)) target[value] = (target[value] ?? 0) + count;
}

/**
 * Works out the filters the site writes: the collection name, then each declared field that has at most
 * {@link MAX_FILTER_VALUES} distinct values. Two collections that declare the same field share one Pagefind filter,
 * so their counts merge. A field over the limit is reported once per collection and left out, because a free-text
 * field would make the index large and the filter useless.
 */
export function filterPlan(
  site: Site,
  records: readonly SearchableRecord[],
  report: (diagnostic: Diagnostic) => void,
): FilterPlan {
  const skipped: Record<string, readonly string[]> = {};
  const byField = new Map<string, Record<string, number>>();
  for (const name of Object.keys(site.collections)) {
    const ofCollection = records.filter((record) => record.collection === name);
    if (ofCollection.length === 0) continue;
    const declared = [...(site.config.collections[name]?.search?.filters ?? [])].sort(byCodePoint);
    const leftOut: string[] = [];
    for (const field of declared) {
      const values = countValues(ofCollection, field);
      if (Object.keys(values).length > MAX_FILTER_VALUES) {
        leftOut.push(field);
        report({
          id: "search.filter-too-many",
          severity: "warning",
          message: `Collection "${name}" has ${Object.keys(values).length} distinct values in "${field}", so it is not written as a filter.`,
          help: `Filter a short or list field instead, or leave "${field}" out of collections.${name}.search.filters.`,
        });
        continue;
      }
      const merged = byField.get(field) ?? countsMap();
      mergeCounts(merged, values);
      byField.set(field, merged);
    }
    if (leftOut.length > 0) skipped[name] = leftOut;
  }
  const fields = [...byField.entries()]
    .map(([field, values]) => ({ field, values }))
    .sort((a, b) => byCodePoint(a.field, b.field));
  return { collection: countValues(records, "collection"), fields, skipped };
}

/** The sort fields one collection writes, and their kind. */
export type SortKind = "date" | "number" | "text";

/** The sort fields a site writes, keyed by collection and field. */
export type SortPlan = Readonly<Record<string, Readonly<Record<string, SortKind>>>>;

/** True when every non-empty string is a finite number. */
function allNumbers(values: readonly string[]): boolean {
  return values.length > 0 && values.every((value) => value.trim() !== "" && Number.isFinite(Number(value)));
}

/**
 * Works out the sort fields the site writes. A field under the collection's `dates` is a date; a field whose values are
 * all numbers is a number; any other field is text only when every value is short. A field that fits none is reported
 * once and left out, because Pagefind would order it as text and the result would read wrong.
 */
export function sortPlan(
  site: Site,
  records: readonly SearchableRecord[],
  report: (diagnostic: Diagnostic) => void,
): SortPlan {
  const plan: Record<string, Record<string, SortKind>> = {};
  for (const name of Object.keys(site.collections)) {
    const ofCollection = records.filter((record) => record.collection === name);
    if (ofCollection.length === 0) continue;
    const entry: CollectionConfig | undefined = site.config.collections[name];
    const declared = [...(entry?.search?.sort ?? [])].sort(byCodePoint);
    const kinds: Record<string, SortKind> = {};
    for (const field of declared) {
      const values = ofCollection.flatMap((record) => valuesOf(record.fields[field]));
      const kind: SortKind | undefined = (entry?.dates ?? []).includes(field)
        ? "date"
        : allNumbers(values)
          ? "number"
          : values.length > 0 && values.every((value) => value.length <= MAX_SORT_TEXT)
            ? "text"
            : undefined;
      if (kind === undefined) {
        report({
          id: "search.sort-unsupported",
          severity: "warning",
          message: `Collection "${name}" cannot sort by "${field}": its values are long text or mixed types.`,
          help: `Sort by a date, a number, or short text, or leave "${field}" out of collections.${name}.search.sort.`,
        });
        continue;
      }
      kinds[field] = kind;
    }
    plan[name] = kinds;
  }
  return plan;
}

/** The value written for a sort field: the normalized date when the collection declares one, else the first scalar. */
export function sortValue(record: SearchableRecord, field: string): string | undefined {
  const normalized = record.record.normalizedDates?.[field];
  if (normalized !== undefined) return normalized;
  return valuesOf(record.fields[field])[0];
}

/** The record a collection index row names, with the page it is published at. */
export interface IndexRecord {
  /** The record's source data. */
  readonly record: DataRecord;
  /** The record's main page, in the default language when it has more than one. */
  readonly page: Page;
}

/**
 * Every record of a collection that has a main page, in source order. When a record has pages in several languages,
 * the default language's page is used, and otherwise the first URL: the index is one row per record.
 */
export function indexRecords(site: Site, name: string): readonly IndexRecord[] {
  const collection = site.collections[name];
  if (collection === undefined) return [];
  const pages = new Map<string, Page>();
  for (const page of site.pages) {
    const identity = page.record;
    if (identity === undefined || identity.collection !== name || identity.view !== undefined) continue;
    const current = pages.get(identity.id);
    if (current === undefined || (page.lang === site.config.lang && current.lang !== site.config.lang)) {
      pages.set(identity.id, page);
    }
  }
  const records: IndexRecord[] = [];
  for (const record of collection.records) {
    const page = pages.get(record.id);
    if (page === undefined) continue;
    records.push({ record, page });
  }
  return records;
}

/** The `data-` attribute value of one Pagefind tag, escaped for a double-quoted attribute. */
export function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

