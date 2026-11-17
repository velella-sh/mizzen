/**
 * Resolves the relations a collection configures: each field under `references` holds the id of a record in another
 * collection, or a list of such ids, and each id becomes that record's page URL and fields in the page's language.
 *
 * A relation keeps the order the record writes its ids in, and the fields keep the order the config writes them, so the
 * same input always gives the same result. A value that names no record, or a target whose page has no URL, is left
 * out: the reference check already reports the first, and the second is a permalink finding. A collection or field
 * without `references` settings has no relations.
 */
import type { Collection, DataRecord, SiteConfig } from "../../contracts/index.ts";
import { localizeFields, prefixOfLang, referenceTargets, urlOfRecord } from "../record-context.ts";

/** One record a configured relation points at, as the page reads it. */
export interface RelatedRecord {
  /** The target collection's name. */
  readonly collection: string;
  /** The target record's id. */
  readonly id: string;
  /** The target record page's URL, including `base` and the page language's prefix. */
  readonly url: string;
  /** The target record's fields in the page's language, with `id` filled in when the source omits it. */
  readonly fields: Readonly<Record<string, unknown>>;
}

/** A record's relations by field name; a field that resolves to nothing is absent. */
export type RecordRelations = Readonly<Record<string, readonly RelatedRecord[]>>;

/** The ids in one relation value: a scalar id, a list of ids, or nothing. */
function idsOf(value: unknown): readonly string[] {
  const values = Array.isArray(value) ? value : [value];
  const ids: string[] = [];
  for (const candidate of values) {
    if (typeof candidate === "string" || typeof candidate === "number") ids.push(String(candidate));
  }
  return ids;
}

/** One related record, or `undefined` when the target record or its URL is absent. */
function relatedRecordOf(
  collections: Readonly<Record<string, Collection>>,
  config: SiteConfig,
  target: string,
  id: string,
  byId: ReadonlyMap<string, DataRecord>,
  prefix: string,
  lang: string,
): RelatedRecord | undefined {
  const record = byId.get(id);
  if (record === undefined) return undefined;
  const url = urlOfRecord(collections, config.collections, config.base, prefix, target, id, lang, config.lang);
  if (url === undefined) return undefined;
  const localized = localizeFields(record.fields, lang, config.lang).fields;
  return {
    collection: target,
    id,
    url,
    fields: localized["id"] === undefined ? { ...localized, id } : localized,
  };
}

/**
 * Resolves the relations of one record of `collection`. Scalar relation fields give one related record and list fields
 * give them in the record's order; an absent, empty, or unresolved value is left out.
 */
export function relationsOf(
  collections: Readonly<Record<string, Collection>>,
  config: SiteConfig,
  collection: string,
  fields: Readonly<Record<string, unknown>>,
  lang: string,
): RecordRelations {
  const targets = referenceTargets(config.collections[collection]);
  const prefix = prefixOfLang(config, lang);
  const relations: Record<string, readonly RelatedRecord[]> = {};
  for (const [field, target] of Object.entries(targets)) {
    const records = collections[target]?.records;
    if (records === undefined) continue;
    const byId = new Map(records.map((record) => [record.id, record]));
    const related = idsOf(fields[field]).flatMap((id): RelatedRecord[] => {
      const record = relatedRecordOf(collections, config, target, id, byId, prefix, lang);
      return record === undefined ? [] : [record];
    });
    if (related.length > 0) relations[field] = related;
  }
  return relations;
}
