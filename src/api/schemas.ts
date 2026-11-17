/**
 * The JSON Schema a collection's API publishes: the collection's own schema limited to the published fields, with
 * `$id` set to the address it is published at. A collection without a schema publishes none and is never described as
 * if it had one.
 *
 * The published schema does not close the record (`additionalProperties` is left open) because a version only ever
 * gains fields, and a reader's validator must keep accepting a record after a field is added.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Diagnostic, Site } from "../contracts/index.ts";
import { apiUrl, type ApiCollection } from "./model.ts";

/** The JSON Schema dialect every published schema uses. */
export const SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The address a collection's schema is published at, absolute when the site sets `url`. */
export function schemaId(site: Site, name: string): string {
  const origin = site.config.url?.replace(/\/+$/, "") ?? "";
  return `${origin}${apiUrl(site, `schemas/${name}.json`)}`;
}

/**
 * The published schema of one collection, or `undefined` when it has none: no schema is named, the file cannot be read
 * as an object schema (the data stage already reports that), or it describes none of the published fields. A published
 * field the schema does not describe is reported as an error.
 */
export function publishedSchema(
  site: Site,
  root: string | undefined,
  collection: ApiCollection,
  report: (diagnostic: Diagnostic) => void,
): Record<string, unknown> | undefined {
  const declared = site.config.collections[collection.name]?.schema;
  if (declared === undefined || root === undefined) return undefined;
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(resolve(root, declared), "utf8"));
  } catch {
    return undefined;
  }
  if (!isObject(document)) return undefined;
  const described = isObject(document.properties) ? document.properties : {};

  const properties: Record<string, unknown> = { [collection.idKey]: { type: "string", description: "The record id." } };
  const required: string[] = [collection.idKey];
  const declaredRequired = Array.isArray(document.required) ? document.required : [];
  for (const field of collection.fields) {
    if (!Object.hasOwn(described, field)) {
      report({
        id: "api.field-not-in-schema",
        severity: "error",
        message: `The API publishes the field "${field}" of "${collection.name}", which its schema ${declared} does not describe.`,
        help: `Add "${field}" to the schema's \`properties\`, or remove it from \`api.collections.${collection.name}.fields\`.`,
      });
      continue;
    }
    properties[field] = described[field];
    if (declaredRequired.includes(field)) required.push(field);
  }

  const out: Record<string, unknown> = {
    $schema: SCHEMA_DIALECT,
    $id: schemaId(site, collection.name),
    title: typeof document.title === "string" ? document.title : collection.name,
    type: "object",
    properties,
    required,
  };
  if (typeof document.description === "string") out.description = document.description;
  // Definitions are kept whole so a `$ref` in a published field still resolves.
  if (isObject(document.$defs)) out.$defs = document.$defs;
  if (isObject(document.definitions)) out.definitions = document.definitions;
  return out;
}
