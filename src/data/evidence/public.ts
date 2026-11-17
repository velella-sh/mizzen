/**
 * The public side of a record's evidence: the claims a page renders and the page JSON publishes, and the raw field a
 * page hides. Both callers read the same helper, so HTML and JSON never disagree about which claims back a field.
 */
import type { DataRecord } from "../../contracts/data.ts";
import type { EvidenceClaim, EvidenceClaims } from "./validate.ts";

/** A parsed mapping, as the data file wrote it; an array or a scalar is not one. */
function isMapping(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One claim's public keys in their written order, or nothing when any of them is missing or empty. */
function claimOf(value: unknown): EvidenceClaim[] {
  if (!isMapping(value)) return [];
  const { id, title, url } = value;
  if (typeof id !== "string" || id === "") return [];
  if (typeof title !== "string" || title === "") return [];
  if (typeof url !== "string" || url === "") return [];
  return [{ id, title, url }];
}

/**
 * The public claims a record keeps under its collection's evidence field, keyed by the field they back in record field
 * order. Every other key is private: only `id`, `title`, and `url` are picked, so a `note` never reaches an output.
 * Absent, empty, or malformed evidence is the normal case and publishes nothing.
 */
export function publicEvidenceOf(
  record: Pick<DataRecord, "fields">,
  field: string | undefined,
): EvidenceClaims | undefined {
  if (field === undefined) return undefined;
  const raw = record.fields[field];
  if (!isMapping(raw)) return undefined;
  const entries: [string, readonly EvidenceClaim[]][] = [];
  for (const backed of Object.keys(record.fields)) {
    if (backed === field) continue;
    const value = raw[backed];
    if (value === undefined) continue;
    const claims = (Array.isArray(value) ? value : [value]).flatMap(claimOf);
    if (claims.length > 0) entries.push([backed, claims]);
  }
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

/** The record's fields without the raw evidence field, which a page or a layout must never show. */
export function withoutEvidence(
  fields: Readonly<Record<string, unknown>>,
  field: string | undefined,
): Readonly<Record<string, unknown>> {
  if (field === undefined || !Object.hasOwn(fields, field)) return fields;
  return Object.fromEntries(Object.entries(fields).filter(([name]) => name !== field));
}
