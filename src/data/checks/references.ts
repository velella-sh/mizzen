/**
 * Reference checks for the fields a collection marks under `references`: each value must be the id of a record in the
 * collection the config names, and one field may hold a list of such ids.
 *
 * A reference is checked, never resolved: the target record is not copied into the source record, so a page can name
 * the target and follow it without duplicating data. A broken reference is one error at the field's span; an unknown
 * target collection is one error, reported once for that field.
 */
import type {
  Collection,
  DataRecord,
  Diagnostic,
  RecordPos,
  SiteConfig,
} from "../../contracts/index.ts";
import { sourcePosOf } from "../positions.ts";

/** The scalar text of a reference value, or `undefined` for a list or mapping. */
function textOf(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

/** The position of a field on a record, falling back to the record itself. */
function posOf(record: DataRecord, field: string): RecordPos {
  return record.fieldPositions[field] ?? record.position;
}

/** The first record that has the field, so an unknown-target finding points at a place a reader can see. */
function firstWith(records: readonly DataRecord[], field: string): DataRecord | undefined {
  return records.find((record) => record.fields[field] !== undefined) ?? records[0];
}

/**
 * Checks every declared reference. A target collection the config does not declare is one error at the first record
 * that uses the field. A target collection that failed to load is left alone: its own finding already says why.
 * Values may be an id or a list of ids; anything else is one error at the field.
 */
export function checkReferences(
  collections: Readonly<Record<string, Collection>>,
  config: SiteConfig,
  diagnostics: Diagnostic[],
): void {
  for (const [name, entry] of Object.entries(config.collections)) {
    const records = collections[name]?.records;
    if (records === undefined) continue;

    for (const [field, targetName] of Object.entries(entry.references ?? {})) {
      const declared = config.collections[targetName];
      if (declared === undefined) {        const record = firstWith(records, field);
        diagnostics.push({
          id: "data.reference-unknown-collection",
          severity: "error",
          message: `Collection "${name}" marks field "${field}" as a reference to "${targetName}", which the config does not declare.`,
          ...(record === undefined ? {} : { pos: sourcePosOf(posOf(record, field)) }),
          help: `Declare \`collections.${targetName}\`, or point the reference at a collection that exists.`,
        });
        continue;
      }

      const target = collections[targetName];
      if (target === undefined) continue;
      const ids = new Set(target.records.map((record) => record.id));
      const example = target.records[0]?.id;

      for (const record of records) {
        const value = record.fields[field];
        if (value === undefined) continue;
        const pos = sourcePosOf(posOf(record, field));
        const values: unknown[] = Array.isArray(value) ? value : [value];
        for (const candidate of values) {
          const text = textOf(candidate);
          if (text === undefined) {
            diagnostics.push({
              id: "data.reference-invalid",
              severity: "error",
              message: `Field "${field}" of record "${record.id}" in "${name}" must be an id or a list of ids.`,
              pos,
              help: `Use a record id from "${targetName}"${example === undefined ? "" : `, such as "${example}"`}.`,
            });
            continue;
          }
          if (ids.has(text)) continue;
          diagnostics.push({
            id: "data.reference-missing",
            severity: "error",
            message: `Field "${field}" of record "${record.id}" in "${name}" references "${text}", which is not a record id in "${targetName}".`,
            pos,
            help: `Use an id from "${targetName}"${example === undefined ? "" : `, such as "${example}"`}.`,
          });
        }
      }
    }
  }
}
