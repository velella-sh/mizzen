/**
 * Reads the knowledge declaration a collection names, once its records are final, and keeps the raw field out of every
 * public output: the declaration lives on {@link DataRecord.knowledge}, and the field itself is removed from the record's
 * fields. A value that is not a valid declaration is reported at the field's exact span and leaves the record `missing`.
 *
 * Parsing is local and synchronous apart from nothing: no file read, no network, no clock.
 */
import type { Collection, CollectionConfig } from "../contracts/index.ts";
import type { Diagnostic } from "../contracts/diagnostic.ts";
import type { DataRecord } from "../contracts/data.ts";
import { KNOWLEDGE_KEY, parseKnowledge } from "./parse.ts";
import { sourcePosOf } from "../data/positions.ts";

/**
 * Applies each collection's named `knowledge` field to its records, returning new collections. The field is removed
 * from `fields`, `fieldPositions`, and `keyPositions` after it is read, so a page, a feed, an API response, or a raw
 * download never carries it; only the parsed declaration remains.
 */
export function applyCollectionKnowledge(
  collections: Readonly<Record<string, Collection>>,
  config: Readonly<Record<string, CollectionConfig>>,
  diagnostics: Diagnostic[],
): Readonly<Record<string, Collection>> {
  const out: Record<string, Collection> = {};
  for (const [name, collection] of Object.entries(collections)) {
    const field = config[name]?.knowledge;
    if (field === undefined) {
      out[name] = collection;
      continue;
    }
    out[name] = {
      ...collection,
      records: collection.records.map((record) => withKnowledge(name, field, record, diagnostics)),
    };
  }
  return out;
}

/** One record with its knowledge read and its raw field dropped. */
function withKnowledge(
  collection: string,
  field: string,
  record: DataRecord,
  diagnostics: Diagnostic[],
): DataRecord {
  const raw = record.fields[field];
  if (raw === undefined) {
    // A record that does not write the field declares nothing; the report keeps it apart as missing.
    return record;
  }
  const span = sourcePosOf(record.fieldPositions[field] ?? record.position);
  const parsed = parseKnowledge(raw, { file: span.file, span, idPrefix: `collection.${collection}.knowledge` });
  diagnostics.push(...parsed.diagnostics);

  const fields = withoutKey(record.fields, field);
  const fieldPositions = withoutKey(record.fieldPositions, field);
  const keyPositions = record.keyPositions === undefined ? undefined : withoutKey(record.keyPositions, field);
  return {
    ...record,
    fields,
    fieldPositions,
    ...(keyPositions === undefined ? {} : { keyPositions }),
    ...(parsed.declaration === undefined ? {} : { knowledge: parsed.declaration }),
  };
}

/** The record's mapping without one key, keeping the others and their order. */
function withoutKey<T>(values: Readonly<Record<string, T>>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(values).filter(([name]) => name !== key));
}

/** The front matter key and the collection field share one name, so a reader can learn it once. */
export const COLLECTION_KNOWLEDGE_FIELD = KNOWLEDGE_KEY;
