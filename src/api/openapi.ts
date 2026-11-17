/**
 * `api/<version>/openapi.json`: an OpenAPI 3.1 description of the files the API writes. Every path it names is a file
 * the build writes; a collection's record path is one template over the ids of its records. The published schemas are the
 * response schemas, so the description and the schemas cannot drift apart.
 */
import type { Site } from "../contracts/index.ts";
import { apiDir, type ApiCollection } from "./model.ts";
import { schemaId } from "./schemas.ts";

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A copy of a schema with each local `$ref` into its own definitions pointed at the published schema file instead. */
function absoluteRefs(value: unknown, id: string): unknown {
  if (Array.isArray(value)) return value.map((item) => absoluteRefs(item, id));
  if (!isObject(value)) return value;
  const out: Json = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = key === "$ref" && typeof item === "string" && item.startsWith("#") ? `${id}${item}` : absoluteRefs(item, id);
  }
  return out;
}

function jsonResponse(description: string, schema: Json): Json {
  return { description, content: { "application/json": { schema } } };
}

/** The schema of one record in a collection file: the published schema, or the id and the listed fields left open. */
function recordSchema(collection: ApiCollection, published: Json | undefined): Json {
  if (published !== undefined) return published;
  const properties: Json = { [collection.idKey]: { type: "string" } };
  for (const field of collection.fields) properties[field] = {};
  return { type: "object", required: [collection.idKey], properties };
}

/** The schema of a record file's `fields`: the published properties without the id, with refs made absolute. */
function fieldsSchema(collection: ApiCollection, published: Json | undefined, id: string): Json {
  if (published === undefined || !isObject(published.properties)) return { type: "object" };
  const { [collection.idKey]: _id, ...properties } = published.properties;
  const required = Array.isArray(published.required) ? published.required.filter((key) => key !== collection.idKey) : [];
  const out: Json = { type: "object", properties: absoluteRefs(properties, id), required };
  if (isObject(published.$defs)) out.$defs = absoluteRefs(published.$defs, id);
  if (isObject(published.definitions)) out.definitions = absoluteRefs(published.definitions, id);
  return out;
}

/** The OpenAPI document. `schemas` holds each published schema by collection name. */
export function openApiDocument(site: Site, collections: readonly ApiCollection[], schemas: ReadonlyMap<string, Json>): Json {
  const api = site.config.api;
  const version = api?.version ?? "v1";
  const dir = `/${apiDir(site)}`;
  const origin = site.config.url?.replace(/\/+$/, "") ?? "";
  const base = site.config.base.replace(/\/+$/, "");
  const components: Json = {};
  const paths: Json = {};

  paths[`${dir}/index.json`] = {
    get: {
      operationId: "getIndex",
      summary: "The index of the published collections",
      responses: { "200": jsonResponse("The index.", { $ref: "#/components/schemas/Index" }) },
    },
  };
  components.Index = {
    type: "object",
    required: ["version", "collections"],
    properties: {
      version: { type: "string" },
      collections: {
        type: "array",
        items: {
          type: "object",
          required: ["name", "count", "fields", "json", "ndjson", "record", "schema", "snapshot"],
          properties: {
            name: { type: "string" },
            count: { type: "integer", minimum: 0 },
            fields: { type: "array", items: { type: "string" } },
            json: { type: "string" },
            ndjson: { type: "string" },
            record: { type: "string" },
            schema: { type: ["string", "null"] },
            snapshot: { type: ["object", "null"] },
          },
        },
      },
    },
  };

  for (const collection of collections) {
    const name = collection.name;
    const published = schemas.get(name);
    const key = name.replace(/(?:^|-)([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase());
    components[`${key}Record`] = recordSchema(collection, published);
    components[`${key}Collection`] = {
      type: "object",
      required: ["collection", "count", "records"],
      properties: {
        collection: { const: name },
        count: { type: "integer", minimum: 0 },
        records: { type: "array", items: { $ref: `#/components/schemas/${key}Record` } },
      },
    };
    paths[`${dir}/${name}.json`] = {
      get: {
        operationId: `get${key}Collection`,
        summary: `Every published record of ${name}, ordered by id`,
        responses: { "200": jsonResponse("The collection.", { $ref: `#/components/schemas/${key}Collection` }) },
      },
    };
    paths[`${dir}/${name}.ndjson`] = {
      get: {
        operationId: `get${key}Ndjson`,
        summary: `The same records, one JSON object per line`,
        responses: {
          "200": { description: "One record per line.", content: { "application/x-ndjson": { schema: { type: "string" } } } },
        },
      },
    };
    paths[`${dir}/${name}/{id}.json`] = {
      get: {
        operationId: `get${key}Record`,
        summary: `One record of ${name}, by id`,
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" }, description: "The record id." }],
        responses: {
          "200": jsonResponse("The record.", {
            type: "object",
            required: ["collection", collection.idKey, "fields", "url", "previousUrls"],
            properties: {
              collection: { const: name },
              [collection.idKey]: { type: "string" },
              fields: fieldsSchema(collection, published, schemaId(site, name)),
              url: { type: ["string", "null"] },
              previousUrls: { type: "array", items: { type: "string" } },
            },
          }),
          "404": { description: "No record has this id." },
        },
      },
    };
    if (published !== undefined) {
      paths[`${dir}/schemas/${name}.json`] = {
        get: {
          operationId: `get${key}Schema`,
          summary: `The JSON Schema of a published ${name} record`,
          responses: { "200": jsonResponse("The schema.", { type: "object" }) },
        },
      };
    }
  }

  return {
    openapi: "3.1.0",
    info: { title: `${site.config.title} data API`, version },
    servers: [{ url: `${origin}${base}` === "" ? "/" : `${origin}${base}` }],
    paths,
    components: { schemas: components },
  };
}
