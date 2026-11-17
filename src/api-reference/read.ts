/**
 * Reads one pinned OpenAPI document into the operation model the reference pages render. The file is YAML or JSON;
 * every `$ref` must be a local JSON pointer, and a resolved reference is replaced by its target, so the model holds no
 * `$ref`.
 *
 * A reference outside the document, absent, cyclic, or naming the wrong kind is one error at the `$ref` it appears on.
 * An error leaves no document, so a page never quietly drops a parameter or a field. Every list in the model is sorted
 * (except `enum`, which keeps the file's order), so reordering the input changes no page.
 */
import { LineCounter, parseDocument, type Node } from "yaml";
import type { Diagnostic, Severity, SourcePos } from "../contracts/index.ts";

/** A value the document gives: a string, number, boolean, `null`, a list, or an object. */
export type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };

/** An HTTP method the reference reads. */
export type ApiMethod = "get" | "put" | "post" | "delete" | "options" | "head" | "patch" | "trace";

/** One operation of the document, with every local reference resolved. */
export interface ApiOperation {
  readonly id: string;
  readonly method: ApiMethod;
  readonly path: string;
  readonly url: string;
  readonly title: string;
  readonly description?: string;
  readonly tags: readonly string[];
  readonly deprecated: boolean;
  readonly server?: string;
  readonly parameters: readonly ApiParameter[];
  readonly requestBody?: ApiRequestBody;
  readonly responses: readonly ApiResponse[];
}

/** One parameter of an operation or its path item. */
export interface ApiParameter {
  readonly name: string;
  readonly in: "path" | "query" | "header" | "cookie";
  readonly required: boolean;
  readonly deprecated: boolean;
  readonly description?: string;
  readonly schema: ApiSchema;
  readonly examples: readonly ApiExample[];
}

/** The body a request sends. */
export interface ApiRequestBody {
  readonly required: boolean;
  readonly description?: string;
  readonly content: readonly ApiMediaType[];
}

/** One response of an operation. */
export interface ApiResponse {
  readonly status: string;
  readonly description: string;
  readonly content: readonly ApiMediaType[];
}

/** One media type of a request body or a response. */
export interface ApiMediaType {
  readonly type: string;
  readonly schema?: ApiSchema;
  readonly examples: readonly ApiExample[];
}

/** One named example, or the single `example` under the name `example`. */
export interface ApiExample {
  readonly name: string;
  readonly summary?: string;
  readonly value: Json;
}

/** The part of a schema the reference shows. */
export interface ApiSchema {
  readonly type?: string | readonly string[];
  readonly format?: string;
  readonly description?: string;
  readonly enum?: readonly Json[];
  readonly default?: Json;
  readonly required: readonly string[];
  readonly properties: readonly ApiProperty[];
  readonly items?: ApiSchema;
  readonly additionalProperties?: boolean | ApiSchema;
}

/** One named property of a schema. */
export interface ApiProperty {
  readonly name: string;
  readonly schema: ApiSchema;
}

/** The document's index fields and its operations. */
export interface ApiDocument {
  readonly title: string;
  readonly version: string;
  readonly description?: string;
  readonly operations: readonly ApiOperation[];
}

/** What {@link readApiReference} read. `document` is absent when any error was found. */
export interface ApiReferenceRead {
  readonly document?: ApiDocument;
  readonly diagnostics: readonly Diagnostic[];
}

type Path = readonly string[];
type Kind = "parameter" | "requestBody" | "response" | "schema" | "pathItem";

interface Located {
  readonly value: Record<string, unknown>;
  readonly path: Path;
}

type Target = { readonly value: unknown; readonly path: Path; readonly key: string } | "external" | "missing";

const METHODS: readonly ApiMethod[] = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];
const PARAMETER_IN = new Set(["path", "query", "header", "cookie"]);
const PARAMETER_ORDER = { path: 0, query: 1, header: 2, cookie: 3 };
const SCHEMA_KEYS = [
  "type",
  "format",
  "enum",
  "default",
  "required",
  "properties",
  "items",
  "additionalProperties",
  "allOf",
  "oneOf",
  "anyOf",
  "not",
  "$defs",
];
const COMPOSITION_KEYS = ["allOf", "oneOf", "anyOf", "not"];
const KIND_NAME: Readonly<Record<Kind, string>> = {
  parameter: "parameter",
  requestBody: "request body",
  response: "response",
  schema: "schema",
  pathItem: "path item",
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Compares by Unicode code point, never by locale or UTF-16 unit. */
function byCodePoint(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const difference = left[index]!.codePointAt(0)! - right[index]!.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

/** A JSON pointer segment: percent-decoded, then `~1` and `~0` undone. */
function decodePointer(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
  } catch {
    return undefined;
  }
}

/** The order responses take: numeric statuses, then ranges, then `default`, then anything else. */
function statusRank(status: string): number {
  if (/^\d{3}$/.test(status)) return 0;
  if (/^[1-5]XX$/.test(status)) return 1;
  if (status === "default") return 2;
  return 3;
}

function compareStatus(a: string, b: string): number {
  const rank = statusRank(a) - statusRank(b);
  if (rank !== 0) return rank;
  const left = statusRank(a);
  if (left === 0) return Number(a) - Number(b);
  if (left === 1) return Number(a[0]) - Number(b[0]);
  return byCodePoint(a, b);
}

/** True when `value` may stand where `kind` is expected. A response and a request body both carry content. */
function hasKind(value: Record<string, unknown>, kind: Kind): boolean {
  if (kind === "pathItem") return false;
  if (METHODS.some((method) => method in value)) return false;
  if ("openapi" in value || "info" in value || "paths" in value) return false;
  if (typeof value.name === "string" && PARAMETER_IN.has(value.in as string)) return kind === "parameter";
  if (kind === "parameter") return false;
  if (SCHEMA_KEYS.some((key) => key in value)) return kind === "schema";
  if (kind === "schema") return !("content" in value);
  if (kind === "response") return typeof value.description === "string";
  return isObject(value.content);
}

/**
 * Reads an OpenAPI 3.1 or 3.0 document. `file` is the path diagnostics name and `path` the site path the operations
 * live under. A document with any error yields no `document`; warnings leave it in place.
 */
export function readApiReference(text: string, file: string, path = "/reference/"): ApiReferenceRead {
  const source = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const lines = new LineCounter();
  const doc = parseDocument(source, { lineCounter: lines });
  const diagnostics: Diagnostic[] = [];

  const posOf = (at: Path): SourcePos | undefined => {
    const node = at.length === 0 ? doc.contents : doc.getIn(at as string[], true);
    const range = (node as Node | null | undefined)?.range;
    if (range === null || range === undefined) return undefined;
    const start = lines.linePos(range[0]);
    const end = lines.linePos(Math.max(range[0], (range[2] ?? range[1]) - 1));
    return { file, line: start.line, column: start.col, endLine: end.line, endColumn: end.col };
  };

  const report = (id: string, severity: Severity, message: string, at: Path, help?: string): void => {
    const pos = posOf(at);
    diagnostics.push({ id, severity, message, ...(pos === undefined ? {} : { pos }), ...(help === undefined ? {} : { help }) });
  };

  if (doc.errors.length > 0) {
    for (const error of doc.errors) {
      const start = error.linePos?.[0];
      diagnostics.push({
        id: "api-reference.input",
        severity: "error",
        message: `The API reference source "${file}" is not valid YAML or JSON: ${error.message.split("\n")[0]}`,
        pos: {
          file,
          line: start?.line ?? 1,
          column: start?.col ?? 1,
          endLine: start?.line ?? 1,
          endColumn: start?.col ?? 1,
        },
      });
    }
    return { diagnostics };
  }

  const root: unknown = doc.toJS();
  if (!isObject(root)) {
    diagnostics.push({
      id: "api-reference.input",
      severity: "error",
      message: `The API reference source "${file}" is not a YAML or JSON object.`,
    });
    return { diagnostics };
  }

  const declared = typeof root.openapi === "string" ? root.openapi : "";
  if (!/^3\.[01]\.\d+$/.test(declared)) {
    report(
      "api-reference.unsupported-version",
      "error",
      `The API reference source "${file}" declares OpenAPI "${declared}", which this version does not read.`,
      ["openapi"],
      "Use an OpenAPI 3.1 or 3.0 document.",
    );
    return { diagnostics };
  }
  const minor = declared.startsWith("3.0.") ? 0 : 1;

  const info = isObject(root.info) ? root.info : undefined;
  const title = typeof info?.title === "string" ? info.title : undefined;
  const version = typeof info?.version === "string" ? info.version : undefined;
  if (title === undefined || version === undefined || !isObject(root.paths)) {
    diagnostics.push({
      id: "api-reference.input",
      severity: "error",
      message: `The API reference source "${file}" needs info.title, info.version, and paths.`,
    });
    return { diagnostics };
  }

  /** The value a local pointer names, with the path that positions diagnostics inside it. */
  const targetOf = (ref: string): Target => {
    if (!ref.startsWith("#/")) return "external";
    const segments = ref.slice(2).split("/");
    const pointer: string[] = [];
    for (const segment of segments) {
      const decoded = decodePointer(segment);
      if (decoded === undefined) return "missing";
      pointer.push(decoded);
    }
    let value: unknown = root;
    for (const segment of pointer) {
      if (Array.isArray(value)) {
        if (!/^\d+$/.test(segment)) return "missing";
        value = value[Number(segment)];
      } else if (isObject(value)) {
        value = value[segment];
      } else {
        return "missing";
      }
      if (value === undefined) return "missing";
    }
    return { value, path: pointer, key: JSON.stringify(pointer) };
  };

  const active = new Set<string>();
  const activeSchemas = new Set<Record<string, unknown>>();

  /** Follows a reference chain to its target and checks the target's kind. */
  const resolve = (value: Record<string, unknown>, at: Path, kind: Kind): Located | undefined => {
    let current = value;
    let currentPath = at;
    let ref = "";
    let refPath = at;
    const seen = new Set<string>();
    while (typeof current.$ref === "string") {
      ref = current.$ref;
      refPath = [...currentPath, "$ref"];
      const target = targetOf(ref);
      if (target === "external") {
        report(
          "api-reference.reference-external",
          "error",
          `The $ref "${ref}" in "${file}" is not a local JSON pointer; external references are never read.`,
          refPath,
          "Use a pointer into this file, such as #/components/schemas/Name.",
        );
        return undefined;
      }
      if (target === "missing") {
        report("api-reference.reference-missing", "error", `The $ref "${ref}" in "${file}" points to nothing.`, refPath);
        return undefined;
      }
      if (seen.has(target.key) || active.has(target.key)) {
        report(
          "api-reference.reference-cycle",
          "error",
          `The $ref "${ref}" in "${file}" returns to a reference it already visited.`,
          refPath,
        );
        return undefined;
      }
      seen.add(target.key);
      if (!isObject(target.value)) {
        report(
          "api-reference.reference-kind",
          "error",
          `The $ref "${ref}" in "${file}" does not name a ${KIND_NAME[kind]}.`,
          refPath,
        );
        return undefined;
      }
      current = target.value;
      currentPath = target.path;
    }

    if (!hasKind(current, kind)) {
      const message =
        kind === "pathItem"
          ? `The $ref "${ref}" in "${file}" names a whole path item, which this version does not read.`
          : `The $ref "${ref}" in "${file}" does not name a ${KIND_NAME[kind]}.`;
      report("api-reference.reference-kind", "error", message, refPath);
      return undefined;
    }
    return { value: current, path: currentPath };
  };

  const examplesOf = (value: Record<string, unknown>, at: Path): ApiExample[] => {
    const out: ApiExample[] = [];
    if (isObject(value.examples)) {
      for (const [name, example] of Object.entries(value.examples)) {
        if (!isObject(example) || !("value" in example)) continue;
        out.push({
          name,
          ...(typeof example.summary === "string" ? { summary: example.summary } : {}),
          value: example.value as Json,
        });
      }
    } else if ("example" in value) {
      out.push({ name: "example", value: value.example as Json });
    }
    return out.sort((a, b) => byCodePoint(a.name, b.name));
  };

  const schemaOf = (value: unknown, at: Path): ApiSchema | undefined => {
    if (!isObject(value)) return undefined;
    let located: Located | undefined;
    if (typeof value.$ref === "string") {
      located = resolve(value, at, "schema");
      if (located === undefined) return undefined;
    } else {
      located = { value, path: at };
    }
    const schema = located.value;
    const schemaPath = located.path;
    const key = JSON.stringify(schemaPath);
    if (active.has(key)) return undefined;
    if (activeSchemas.has(schema)) {
      report(
        "api-reference.reference-cycle",
        "error",
        `The schema "${refOf(at)}" in "${file}" returns to itself through a YAML alias.`,
        at,
      );
      return undefined;
    }
    active.add(key);
    activeSchemas.add(schema);

    for (const composition of COMPOSITION_KEYS) {
      if (!(composition in schema)) continue;
      const pos = posOf([...schemaPath, composition]);
      diagnostics.push({
        id: "api-reference.schema-composition",
        severity: "warning",
        message: `Schema "${refOf(schemaPath)}" in "${file}" uses "${composition}", which this version does not combine; the schema is shown with the keywords it carries.`,
        ...(pos === undefined ? {} : { pos }),
      });
    }

    let type: string | readonly string[] | undefined;
    if (typeof schema.type === "string") {
      type = schema.type;
    } else if (Array.isArray(schema.type) && schema.type.every((item) => typeof item === "string")) {
      type = schema.type as readonly string[];
    }
    if (minor === 0 && schema.nullable === true && type !== undefined) {
      type = Array.isArray(type) ? [...type, "null"] : [type, "null"];
    }

    const required = Array.isArray(schema.required)
      ? schema.required.filter((name): name is string => typeof name === "string").sort(byCodePoint)
      : [];
    const properties: ApiProperty[] = [];
    if (isObject(schema.properties)) {
      for (const [name, property] of Object.entries(schema.properties)) {
        const normalized = schemaOf(property, [...schemaPath, "properties", name]);
        if (normalized !== undefined) properties.push({ name, schema: normalized });
      }
    }
    properties.sort((a, b) => byCodePoint(a.name, b.name));

    const items = isObject(schema.items) ? schemaOf(schema.items, [...schemaPath, "items"]) : undefined;
    const additionalProperties =
      typeof schema.additionalProperties === "boolean"
        ? schema.additionalProperties
        : isObject(schema.additionalProperties)
          ? schemaOf(schema.additionalProperties, [...schemaPath, "additionalProperties"])
          : undefined;

    active.delete(key);
    activeSchemas.delete(schema);
    return {
      ...(type === undefined ? {} : { type }),
      ...(typeof schema.format === "string" ? { format: schema.format } : {}),
      ...(typeof schema.description === "string" ? { description: schema.description } : {}),
      ...(Array.isArray(schema.enum) ? { enum: schema.enum as readonly Json[] } : {}),
      ...("default" in schema ? { default: schema.default as Json } : {}),
      required,
      properties,
      ...(items === undefined ? {} : { items }),
      ...(additionalProperties === undefined ? {} : { additionalProperties }),
    };
  };

  const mediaTypesOf = (value: unknown, at: Path): ApiMediaType[] => {
    if (!isObject(value)) return [];
    const out: ApiMediaType[] = [];
    for (const [type, media] of Object.entries(value)) {
      if (!isObject(media)) {
        out.push({ type, examples: [] });
        continue;
      }
      const schema = isObject(media.schema) ? schemaOf(media.schema, [...at, type, "schema"]) : undefined;
      out.push({
        type,
        ...(schema === undefined ? {} : { schema }),
        examples: examplesOf(media, [...at, type]),
      });
    }
    return out.sort((a, b) => byCodePoint(a.type, b.type));
  };

  const parametersOf = (value: unknown, at: Path): ApiParameter | undefined => {
    if (!isObject(value)) return undefined;
    let located: Located | undefined;
    if (typeof value.$ref === "string") {
      located = resolve(value, at, "parameter");
      if (located === undefined) return undefined;
    } else {
      located = { value, path: at };
    }
    const parameter = located.value;
    const location = parameter.in as ApiParameter["in"];
    const schema = isObject(parameter.schema)
      ? schemaOf(parameter.schema, [...located.path, "schema"])
      : undefined;
    return {
      name: parameter.name as string,
      in: location,
      required: location === "path" || parameter.required === true,
      deprecated: parameter.deprecated === true,
      ...(typeof parameter.description === "string" ? { description: parameter.description } : {}),
      schema: schema ?? { required: [], properties: [] },
      examples: examplesOf(parameter, located.path),
    };
  };

  const requestBodyOf = (value: unknown, at: Path): ApiRequestBody | undefined => {
    if (!isObject(value)) return undefined;
    let located: Located | undefined;
    if (typeof value.$ref === "string") {
      located = resolve(value, at, "requestBody");
      if (located === undefined) return undefined;
    } else {
      located = { value, path: at };
    }
    const body = located.value;
    return {
      required: body.required === true,
      ...(typeof body.description === "string" ? { description: body.description } : {}),
      content: mediaTypesOf(body.content, [...located.path, "content"]),
    };
  };

  const responseOf = (status: string, value: unknown, at: Path): ApiResponse | undefined => {
    if (!isObject(value)) return undefined;
    let located: Located | undefined;
    if (typeof value.$ref === "string") {
      located = resolve(value, at, "response");
      if (located === undefined) return undefined;
    } else {
      located = { value, path: at };
    }
    const response = located.value;
    return {
      status,
      description: typeof response.description === "string" ? response.description : "",
      content: mediaTypesOf(response.content, [...located.path, "content"]),
    };
  };

  const operations: ApiOperation[] = [];
  const ids = new Map<string, string>();
  const prefix = path.endsWith("/") ? path : `${path}/`;

  for (const [route, value] of Object.entries(root.paths)) {
    if (!isObject(value)) continue;
    const itemPath = ["paths", route];
    if (typeof value.$ref === "string") {
      resolve(value, itemPath, "pathItem");
      continue;
    }

    for (const method of METHODS) {
      const operation = value[method];
      if (!isObject(operation)) continue;
      const operationPath = [...itemPath, method];

      const id = typeof operation.operationId === "string" ? operation.operationId : undefined;
      if (id === undefined || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
        report(
          "api-reference.operation-id",
          "error",
          `Operation "${method.toUpperCase()} ${route}" in "${file}" has no operationId matching [A-Za-z0-9][A-Za-z0-9._-]*.`,
          [...operationPath, "operationId"],
        );
        continue;
      }
      const folded = id.toLowerCase();
      const previous = ids.get(folded);
      if (previous !== undefined) {
        report(
          "api-reference.duplicate-id",
          "error",
          `Operation id "${id}" in "${file}" duplicates "${previous}" after case folding.`,
          [...operationPath, "operationId"],
        );
        continue;
      }
      ids.set(folded, id);

      const merged = new Map<string, Located>();
      for (const [base, list] of [
        [itemPath, value.parameters],
        [operationPath, operation.parameters],
      ] as const) {
        if (!Array.isArray(list)) continue;
        for (const [index, entry] of list.entries()) {
          if (!isObject(entry)) continue;
          let parameter: Located | undefined;
          if (typeof entry.$ref === "string") {
            parameter = resolve(entry, [...base, "parameters", String(index)], "parameter");
            if (parameter === undefined) continue;
          } else {
            parameter = { value: entry, path: [...base, "parameters", String(index)] };
          }
          const name = parameter.value.name;
          const location = parameter.value.in;
          if (typeof name !== "string" || typeof location !== "string" || !PARAMETER_IN.has(location)) continue;
          merged.set(`${location}\u0000${name}`, parameter);
        }
      }
      const parameters: ApiParameter[] = [];
      for (const parameter of merged.values()) {
        const normalized = parametersOf(parameter.value, parameter.path);
        if (normalized !== undefined) parameters.push(normalized);
      }
      parameters.sort(
        (a, b) => PARAMETER_ORDER[a.in] - PARAMETER_ORDER[b.in] || byCodePoint(a.name, b.name),
      );

      let requestBody: ApiRequestBody | undefined;
      if (operation.requestBody !== undefined) {
        requestBody = requestBodyOf(operation.requestBody, [...operationPath, "requestBody"]);
      }

      const responses: ApiResponse[] = [];
      if (isObject(operation.responses)) {
        for (const [status, response] of Object.entries(operation.responses)) {
          const normalized = responseOf(status, response, [...operationPath, "responses", status]);
          if (normalized !== undefined) responses.push(normalized);
        }
      }
      responses.sort((a, b) => compareStatus(a.status, b.status));

      const summary = typeof operation.summary === "string" && operation.summary.trim() !== "" ? operation.summary : undefined;
      const tags = Array.isArray(operation.tags)
        ? operation.tags.filter((tag): tag is string => typeof tag === "string").sort(byCodePoint)
        : [];
      const server =
        firstServer(operation.servers) ?? firstServer(value.servers) ?? firstServer(root.servers);

      operations.push({
        id,
        method,
        path: route,
        url: `${prefix}${id}/`,
        title: summary ?? `${method.toUpperCase()} ${route}`,
        ...(typeof operation.description === "string" ? { description: operation.description } : {}),
        tags,
        deprecated: operation.deprecated === true,
        ...(server === undefined ? {} : { server }),
        parameters,
        ...(requestBody === undefined ? {} : { requestBody }),
        responses,
      });
    }
  }

  operations.sort((a, b) => byCodePoint(a.url, b.url));
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) return { diagnostics };

  return {
    document: {
      title,
      version,
      ...(typeof info?.description === "string" ? { description: info.description } : {}),
      operations,
    },
    diagnostics,
  };
}

/** The first `url` a `servers` list names. */
function firstServer(servers: unknown): string | undefined {
  if (!Array.isArray(servers)) return undefined;
  for (const server of servers) {
    if (isObject(server) && typeof server.url === "string" && server.url !== "") return server.url;
  }
  return undefined;
}

/** A path as a JSON pointer, for a diagnostic that names the schema it is about. */
function refOf(path: Path): string {
  return `#/${path.map((segment) => segment.replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`;
}
