/**
 * Loads and compiles each collection's JSON Schema once per build, then checks every record against it and maps a
 * failing keyword to the record's field and the field's span. A schema that cannot be read or compiled is one error
 * naming the file, and the collection's records are left unchecked rather than dropped.
 *
 * A record that fails is left out of the site, because a page built from invalid data is the problem this stage
 * exists to prevent. `onInvalid` decides how loud the finding is: `error` fails the build, `skip` warns and keeps
 * building the sound records. Remote `$ref` targets are never fetched; such a schema is a compile error.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { relative, resolve, sep } from "node:path";
import type { ErrorObject, ValidateFunction } from "ajv";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import type {
  CollectionConfig,
  DataRecord,
  Diagnostic,
  RecordPos,
  SiteConfig,
  SourcePos,
} from "../contracts/index.ts";
import { policyOf } from "./policy.ts";
import { sourcePosOf } from "./positions.ts";
import { suggestionFor, type SourceFormat, type Suggestion } from "./schema-fix.ts";

// ajv is CommonJS: its default export is the class at run time, but its types name it.
const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;

/** One collection's compiled schema and the fields it declares. */
export interface CollectionSchema {
  /** The schema file, relative to the site root, with `/` separators. */
  readonly file: string;
  /** Validates one record's fields; `false` leaves its findings in `errors`. */
  readonly validate: ValidateFunction;
  /** The root schema's declared field names, for an unknown-field suggestion. */
  readonly properties: readonly string[];
  /** Each top-level field's declared type, for a missing-field suggestion. */
  readonly fieldTypes: Readonly<Record<string, string>>;
}

/** What {@link compileSchemas} found. */
export interface CompiledSchemas {
  /** Compiled schemas keyed by collection name; a collection whose schema failed is absent. */
  readonly schemas: Readonly<Record<string, CollectionSchema>>;
  /** Collections with no schema, in config order, so `doctor` can say their records are unchecked. */
  readonly unchecked: readonly string[];
}

/** The first line of an error's message, for a diagnostic that stays one sentence. */
function firstLine(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.split("\n")[0] ?? text;
}

/** A position at the start of a schema file. */
function atSchema(file: string): SourcePos {
  return { file, line: 1, column: 1, endLine: 1, endColumn: 1 };
}

/** The declared field names of a root schema object. */
function propertiesOf(document: unknown): string[] {
  if (typeof document !== "object" || document === null) return [];
  const properties = (document as { readonly properties?: unknown }).properties;
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) return [];
  return Object.keys(properties);
}

/** The declared `type` of each root field that names one. */
function fieldTypesOf(document: unknown): Record<string, string> {
  const types: Record<string, string> = {};
  if (typeof document !== "object" || document === null) return types;
  const properties = (document as { readonly properties?: unknown }).properties;
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) return types;
  for (const [field, value] of Object.entries(properties as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const type = (value as { readonly type?: unknown }).type;
    if (typeof type === "string") types[field] = type;
    else if (Array.isArray(type)) {
      const named = type.find((entry): entry is string => typeof entry === "string" && entry !== "null");
      if (named !== undefined) types[field] = named;
    }
  }
  return types;
}

/**
 * Reads and compiles every schema the config names, once per build. A collection without a schema is remembered as
 * unchecked; a schema that cannot be read, parsed, or compiled is one error naming the file and leaves its records
 * unchecked, so a broken schema never turns into one error per record.
 */
export function compileSchemas(
  root: string,
  config: SiteConfig,
  positions: Readonly<Record<string, SourcePos>>,
  diagnostics: Diagnostic[],
): CompiledSchemas {
  const schemas: Record<string, CollectionSchema> = {};
  const unchecked: string[] = [];

  for (const [name, entry] of Object.entries(config.collections)) {
    const declared = entry.schema;
    if (declared === undefined) {
      unchecked.push(name);
      continue;
    }
    const path = resolve(root, declared);
    const file = relative(root, path).split(sep).join("/");
    const configPos = positions[name];
    const at = (pos: SourcePos | undefined): { readonly pos?: SourcePos } => (pos === undefined ? {} : { pos });

    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      diagnostics.push({
        id: "data.schema-missing",
        severity: "error",
        message: `Collection "${name}" names schema ${file}, which cannot be read.`,
        ...at(configPos),
        help: `Check \`collections.${name}.schema\` in mizzen.yml.`,
      });
      continue;
    }

    let document: unknown;
    try {
      document = JSON.parse(text);
    } catch (err) {
      diagnostics.push({
        id: "data.schema-invalid",
        severity: "error",
        message: `Schema ${file} is not valid JSON: ${firstLine(err)}`,
        pos: atSchema(file),
        help: "Fix the JSON, or point the collection at another schema file.",
      });
      continue;
    }
    // A boolean is a valid JSON Schema: `true` accepts every record and `false` rejects every one.
    if (typeof document !== "boolean" && (typeof document !== "object" || document === null || Array.isArray(document))) {
      diagnostics.push({
        id: "data.schema-invalid",
        severity: "error",
        message: `Schema ${file} must be a JSON object or boolean.`,
        pos: atSchema(file),
        help: "Start the schema with `{` and name its fields under `properties`, or write `true` or `false`.",
      });
      continue;
    }

    let validate: ValidateFunction;
    try {
      // `strict: false` accepts ordinary schemas; `logger: false` keeps a build's output stable.
      validate = new Ajv2020({ allErrors: true, strict: false, logger: false }).compile(document);
    } catch (err) {
      diagnostics.push({
        id: "data.schema-invalid",
        severity: "error",
        message: `Schema ${file} cannot be compiled: ${firstLine(err)}`,
        pos: atSchema(file),
        help: "Fix the schema; a remote `$ref` must be written out in the file, since a build reads no network.",
      });
      continue;
    }

    schemas[name] = { file, validate, properties: propertiesOf(document), fieldTypes: fieldTypesOf(document) };
  }

  return { schemas, unchecked };
}

/** What {@link validateRecords} kept and left out. */
export interface ValidationResult {
  /** The records that passed, in source order. */
  readonly records: readonly DataRecord[];
  /** Records left out because they failed. */
  readonly skipped: number;
}

/** The path a finding points at, such as `["author", "name"]`; empty when the record itself failed. */
function pathOf(error: ErrorObject): string[] {
  const path = error.instancePath
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (error.keyword === "required" || error.keyword === "additionalProperties") {
    const extra = error.keyword === "required" ? error.params["missingProperty"] : error.params["additionalProperty"];
    if (typeof extra === "string") path.push(extra);
  }
  return path;
}

const HIDING = new Set(["anyOf", "oneOf", "allOf", "not", "if", "then", "else"]);

/** Groups findings that describe the same top-level field, and picks the most specific one of each group. */
function groupsOf(errors: readonly ErrorObject[]): Map<string, ErrorObject> {
  const groups = new Map<string, ErrorObject>();
  for (const error of errors) {
    const path = pathOf(error);
    const field = path[0] ?? "";
    const found = groups.get(field);
    if (found === undefined) groups.set(field, error);
    else if (HIDING.has(found.keyword) && !HIDING.has(error.keyword)) groups.set(field, error);
  }
  return groups;
}

/** One sentence ending in a period, from ajv's English message. */
function sentence(text: string): string {
  return `${text.trim().replace(/\.+$/, "")}.`;
}

/** The article and noun for a JSON type, such as `a string`. */
function typePhrase(type: string): string {
  return `${/^[aeiou]/.test(type) ? "an" : "a"} ${type}`;
}

function allowedOf(error: ErrorObject): readonly unknown[] | undefined {
  if (error.keyword === "enum") {
    const values = error.params["allowedValues"];
    if (Array.isArray(values)) return values as unknown[];
  }
  if (error.keyword === "const") return [error.params["allowedValue"]];
  return undefined;
}

function expectedTypeOf(error: ErrorObject, field: string, schema: CollectionSchema): string | undefined {
  const named = error.params["type"];
  if (error.keyword === "type" && typeof named === "string") return named;
  return schema.fieldTypes[field];
}

/** The position a finding gets: the field's span, else the record's. */
function posOf(record: DataRecord, field: string | undefined): RecordPos {
  if (field === undefined) return record.position;
  return record.fieldPositions[field] ?? record.position;
}

/** The message for one finding, naming the record, the field, and the value's place. */
function messageOf(error: ErrorObject, record: DataRecord, collection: string, path: readonly string[]): string {
  const subject = `Record "${record.id}" of "${collection}"`;
  if (path.length === 0) return `${subject} does not match its schema: ${sentence(error.message ?? "the record is not valid")}`;
  const field = path[0]!;
  if (path.length === 1 && error.keyword === "required") {
    return `${subject} is missing the required field "${field}".`;
  }
  if (path.length === 1 && error.keyword === "additionalProperties") {
    return `${subject} has an unknown field "${field}".`;
  }
  const where = `Field "${path.join(".")}" of record "${record.id}" in "${collection}"`;
  if (error.keyword === "required") return `${where} is required.`;
  switch (error.keyword) {
    case "type":
      return `${where} must be ${typePhrase(String(error.params["type"] ?? "the right type"))}.`;
    case "enum": {
      const values = (error.params["allowedValues"] as unknown[] | undefined) ?? [];
      return `${where} must be one of ${values.map((value) => JSON.stringify(value)).join(", ")}.`;
    }
    case "const":
      return `${where} must be ${JSON.stringify(error.params["allowedValue"])}.`;
    case "pattern":
      return `${where} must match the pattern ${String(error.params["pattern"])}.`;
    case "minimum":
    case "maximum":
    case "exclusiveMinimum":
    case "exclusiveMaximum": {
      const limit = String(error.params["limit"]);
      const words: Record<string, string> = {
        minimum: `at least ${limit}`,
        maximum: `at most ${limit}`,
        exclusiveMinimum: `greater than ${limit}`,
        exclusiveMaximum: `less than ${limit}`,
      };
      return `${where} must be ${words[error.keyword]}.`;
    }
    case "minLength":
    case "maxLength": {
      const limit = String(error.params["limit"]);
      return `${where} must be ${error.keyword === "minLength" ? "at least" : "at most"} ${limit} characters.`;
    }
    case "format":
      return `${where} must be a ${String(error.params["format"])}.`;
    default:
      return `${where} ${sentence(error.message ?? "does not match the schema")}`;
  }
}

/** The identity of a fix, so one header cell shared by many rows is offered once. */
function fixKey(fix: NonNullable<Diagnostic["fix"]>): string {
  return `${fix.file}\u0000${fix.line}\u0000${fix.column}\u0000${fix.endLine}\u0000${fix.endColumn}\u0000${fix.text}`;
}

/**
 * One finding for a field group, with the suggestion the schema makes possible. A suggestion for a required field
 * nested under another one is left out: only the root schema is known here, so its name and type would be the parent's.
 */
function findingOf(
  error: ErrorObject,
  record: DataRecord,
  collection: string,
  schema: CollectionSchema,
  format: SourceFormat,
  offered: Set<string>,
): Omit<Diagnostic, "severity"> {
  const path = pathOf(error);
  const field = path[0];
  const pos = posOf(record, field);
  const value = field === undefined ? undefined : record.fields[field];
  const allowed = allowedOf(error);
  const expectedType = error.keyword === "required" && path.length > 1 ? undefined : expectedTypeOf(error, path.at(-1) ?? "", schema);
  // A required or unknown field below the root has no span of its own here: only the root schema and its keys are known.
  const nested = path.length > 1 && (error.keyword === "required" || error.keyword === "additionalProperties");
  const suggestion: Suggestion = nested
    ? {}
    : suggestionFor({
        keyword: error.keyword,
        field: field ?? "",
        ...(value === undefined ? {} : { value }),
        ...(allowed === undefined ? {} : { allowed }),
        ...(schema.properties.length === 0 ? {} : { knownFields: schema.properties }),
        ...(expectedType === undefined ? {} : { expectedType }),
        format,
        pos,
        ...(field === undefined || record.keyPositions?.[field] === undefined ? {} : { keyPos: record.keyPositions[field] }),
        ...(field === undefined
          ? {}
          : { accepts: (candidate: unknown) => schema.validate({ ...record.fields, [field]: candidate }) }),
      });
  const fix = suggestion.fix;
  const key = fix === undefined ? undefined : fixKey(fix);
  const first = key === undefined || !offered.has(key);
  if (key !== undefined) offered.add(key);
  const message = messageOf(error, record, collection, path);
  return {
    id: "data.record-invalid",
    message,
    pos: sourcePosOf(pos),
    ...(suggestion.help === undefined ? {} : { help: suggestion.help }),
    ...(fix === undefined || !first ? {} : { fix }),
  };
}

/**
 * Checks every record against its collection's schema and keeps the sound ones. A finding names the collection, the
 * record id, and the field, and points at the field's value; a field the schema says is missing points at the record.
 * `onInvalid` sets the severity: `error` fails the build, `skip` warns.
 */
export function validateRecords(
  collection: string,
  records: readonly DataRecord[],
  schema: CollectionSchema,
  config: CollectionConfig | undefined,
  format: SourceFormat,
  diagnostics: Diagnostic[],
): ValidationResult {
  const severity = policyOf(config) === "skip" ? "warning" : "error";
  const kept: DataRecord[] = [];
  const offered = new Set<string>();

  for (const record of records) {
    if (schema.validate(record.fields)) {
      kept.push(record);
      continue;
    }
    const errors = [...(schema.validate.errors ?? [])];
    if (errors.length === 0) {
      diagnostics.push({
        id: "data.record-invalid",
        severity,
        message: `Record "${record.id}" of "${collection}" does not match its schema. The record was skipped.`,
        pos: sourcePosOf(record.position),
      });
      continue;
    }
    for (const error of groupsOf(errors).values()) {
      const finding = findingOf(error, record, collection, schema, format, offered);
      diagnostics.push({ ...finding, severity, message: `${finding.message} The record was skipped.` });
    }
  }

  return { records: kept, skipped: records.length - kept.length };
}
