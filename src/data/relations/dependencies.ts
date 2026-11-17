/**
 * The records a page's output reads through configured relations: a record page reads the records its own reference
 * fields point at, and a list page reads the records its rows' reference fields point at. An id that names no record is
 * kept, so a page is rebuilt when the record it names appears or goes away.
 *
 * The list is deduplicated and sorted by field, target collection, and id, so the same page always gives the same list
 * and a cache key never depends on the order rows or ids were written in. A collection or field without `references`
 * settings has no dependencies.
 */
import type { Page, Site } from "../../contracts/index.ts";

/** One record a page reads through a configured relation. */
export interface RelationDependency {
  /** The relation field, on the page's own record or on a list row. */
  readonly field: string;
  /** The target collection's name. */
  readonly collection: string;
  /** The target record's id. */
  readonly id: string;
}

/** The ids in one relation value: a scalar id, a list of ids, or nothing. */
function idsOf(value: unknown): readonly string[] {
  const values = Array.isArray(value) ? value : [value];
  const ids: string[] = [];
  for (const candidate of values) {
    if (typeof candidate === "string" || typeof candidate === "number") ids.push(String(candidate));
  }
  return ids;
}

/** Compares dependencies by field, target collection, then id. */
function compare(a: RelationDependency, b: RelationDependency): number {
  return (
    (a.field < b.field ? -1 : a.field > b.field ? 1 : 0) ||
    (a.collection < b.collection ? -1 : a.collection > b.collection ? 1 : 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * A function giving the relation dependencies of a page. The site's records and every collection's reference fields
 * are read once, so a build keys every page without walking a collection for each one.
 */
export function relationDependenciesOf(site: Site): (page: Page) => readonly RelationDependency[] {
  const fieldsByRecord = new Map<string, Map<string, Readonly<Record<string, unknown>>>>();
  for (const [name, collection] of Object.entries(site.collections)) {
    fieldsByRecord.set(name, new Map(collection.records.map((record) => [record.id, record.fields])));
  }
  const targetsByCollection = new Map<string, readonly (readonly [string, string])[]>();
  const targetsOf = (collection: string): readonly (readonly [string, string])[] => {
    let targets = targetsByCollection.get(collection);
    if (targets === undefined) {
      const references = site.config.collections[collection]?.references ?? {};
      targets = Object.keys(references)
        .sort()
        .map((field) => [field, references[field]!] as const);
      targetsByCollection.set(collection, targets);
    }
    return targets;
  };
  const add = (
    found: Map<string, RelationDependency>,
    collection: string,
    fields: Readonly<Record<string, unknown>>,
  ): void => {
    for (const [field, target] of targetsOf(collection)) {
      for (const id of idsOf(fields[field])) {
        found.set(`${field}\u0000${target}\u0000${id}`, { field, collection: target, id });
      }
    }
  };
  return (page) => {
    const found = new Map<string, RelationDependency>();
    const record = page.record;
    if (record !== undefined) {
      const fields = fieldsByRecord.get(record.collection)?.get(record.id);
      if (fields !== undefined) add(found, record.collection, fields);
    }
    if (page.list !== undefined) {
      for (const row of page.list.records) add(found, page.list.collection, row.fields);
    }
    return [...found.values()].sort(compare);
  };
}
