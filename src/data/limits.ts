/**
 * Limits on a collection's source, so one huge or hostile data file cannot exhaust a build. Every limit is per
 * collection and is raised in `mizzen.yml` under `collections.<name>.limits`; the default is stated here and in
 * `docs/data-sites.md`.
 *
 * A source over a limit is one error that names the limit and the config key that raises it. The file is never
 * truncated: a build either reads it whole or reports it and leaves it out.
 */
import type { CollectionConfig, DataRecord, Diagnostic } from "../contracts/index.ts";
import { sourcePosOf } from "./positions.ts";

/** A collection's limits, all already filled with their defaults. */
export interface DataLimits {
  /** Largest source file, in bytes. */
  readonly bytes: number;
  /** Largest number of records a source may hold. */
  readonly records: number;
  /** Largest value of one top-level field, in characters (code points for a string). */
  readonly field: number;
}

/** The limits a collection without a `limits` key gets. */
export const DEFAULT_DATA_LIMITS: DataLimits = {
  bytes: 2 * 1024 * 1024,
  records: 10_000,
  field: 100_000,
};

/** The config key that raises one limit, for a message a reader can act on. */
function keyOf(collection: string, limit: keyof DataLimits): string {
  return `collections.${collection}.limits.${limit}`;
}

/** Fills a collection's configured limits over the defaults. */
export function dataLimitsOf(collection: string, config: CollectionConfig | undefined): DataLimits {
  return {
    bytes: config?.limits?.bytes ?? DEFAULT_DATA_LIMITS.bytes,
    records: config?.limits?.records ?? DEFAULT_DATA_LIMITS.records,
    field: config?.limits?.field ?? DEFAULT_DATA_LIMITS.field,
  };
}

/** One error when a source is larger than its limit; `undefined` at or below it. */
export function checkSourceBytes(
  collection: string,
  source: string,
  bytes: number,
  limits: DataLimits,
): Diagnostic | undefined {
  if (bytes <= limits.bytes) return undefined;
  return {
    id: "data.source-too-large",
    severity: "error",
    message: `Collection "${collection}" reads ${bytes} bytes from ${source}; the limit is ${limits.bytes}.`,
    help: `Raise ${keyOf(collection, "bytes")} in mizzen.yml, or split the source.`,
  };
}

/** One error when a source holds more records than its limit; `undefined` at or below it. */
export function checkRecordCount(
  collection: string,
  source: string,
  count: number,
  limits: DataLimits,
): Diagnostic | undefined {
  if (count <= limits.records) return undefined;
  return {
    id: "data.too-many-records",
    severity: "error",
    message: `Collection "${collection}" reads ${count} records from ${source}; the limit is ${limits.records}.`,
    help: `Raise ${keyOf(collection, "records")} in mizzen.yml, or split the source.`,
  };
}

/** The size of a value in characters; a non-string is measured by its JSON text. */
function valueSize(value: unknown): number {
  if (typeof value === "string") return [...value].length;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

/** One error per record with a field over the limit, naming the record and the field. */
export function checkFieldSizes(
  collection: string,
  records: readonly DataRecord[],
  limits: DataLimits,
): Diagnostic[] {
  const found: Diagnostic[] = [];
  for (const record of records) {
    for (const [field, value] of Object.entries(record.fields)) {
      const size = valueSize(value);
      if (size <= limits.field) continue;
      const pos = record.fieldPositions[field] ?? record.position;
      found.push({
        id: "data.field-too-large",
        severity: "error",
        message: `Field "${field}" of record "${record.id}" in "${collection}" holds ${size} characters; the limit is ${limits.field}.`,
        pos: sourcePosOf(pos),
        help: `Raise ${keyOf(collection, "field")} in mizzen.yml, or shorten the value.`,
      });
      break;
    }
  }
  return found;
}
