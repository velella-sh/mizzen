/**
 * Uniqueness checks for a collection: no two records share an id, and no two share a value in a field the config
 * lists under `unique`. Values are compared by code point, so `North` and `north` are different values and are kept.
 *
 * The check reports and keeps every record. It never drops one: only schema validation decides what the site holds.
 */
import type { CollectionConfig, DataRecord, Diagnostic, RecordPos } from "../../contracts/index.ts";
import { sourcePosOf } from "../positions.ts";

/** The comparable text of a value, or `undefined` for a list or mapping, which uniqueness does not compare. */
function keyOf(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "object") return undefined;
  return String(value);
}

/** `file:line:column` of a position, for a message that names where the first record sits. */
function where(pos: RecordPos): string {
  return `${pos.file}:${pos.startLine}:${pos.startColumn}`;
}

/** The finding for one repeated value, naming both records and both positions. */
function repeated(
  id: string,
  collection: string,
  field: string,
  record: DataRecord,
  pos: RecordPos,
  found: readonly RecordPos[],
): Diagnostic {
  const earlier = `${where(found[0]!)}${found.length > 1 ? ` and ${found.length - 1} more` : ""}`;
  return {
    id,
    severity: "error",
    message:
      field === ""
        ? `Record "${record.id}" of "${collection}" repeats an id first used at ${earlier} (${where(pos)}).`
        : `Field "${field}" of record "${record.id}" in "${collection}" repeats "${keyOf(record.fields[field])}", first used at ${earlier} (${where(pos)}).`,
    pos: sourcePosOf(pos),
    help: `Give each record its own ${field === "" ? "id" : `\`${field}\` value`}.`,
  };
}

/**
 * Reports each repeated id and each repeated `unique` field value. One finding per repeat, pointing at the record or
 * field that repeats, and naming where the value was first used.
 */
export function checkUnique(
  collection: string,
  records: readonly DataRecord[],
  config: CollectionConfig | undefined,
  diagnostics: Diagnostic[],
): void {
  const ids = new Map<string, { positions: RecordPos[] }>();
  for (const record of records) {
    const found = ids.get(record.id);
    if (found === undefined) {
      ids.set(record.id, { positions: [record.position] });
      continue;
    }
    diagnostics.push(repeated("data.duplicate-id", collection, "", record, record.position, found.positions));
    found.positions.push(record.position);
  }

  for (const field of config?.unique ?? []) {
    const values = new Map<string, { positions: RecordPos[] }>();
    for (const record of records) {
      const key = keyOf(record.fields[field]);
      if (key === undefined) continue;
      const pos = record.fieldPositions[field] ?? record.position;
      const found = values.get(key);
      if (found === undefined) {
        values.set(key, { positions: [pos] });
        continue;
      }
      diagnostics.push(repeated("data.duplicate-value", collection, field, record, pos, found.positions));
      found.positions.push(pos);
    }
  }
}
