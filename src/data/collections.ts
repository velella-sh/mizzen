/**
 * Reads the collections a site config declares: a YAML or JSON file, a CSV file, an installed package, or a pinned
 * `https:` source. Records keep their source order and the exact span of the record and each top-level field, so a
 * later stage can point at the line to edit.
 *
 * Collections are read in addition to `Site.data`; nothing here changes what `_data` holds. A content problem is a
 * diagnostic, never a throw: one bad record is left out while the sound ones load, and a source that cannot be read
 * adds no records and says why.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isMap, isSeq, parseDocument, LineCounter, type Document, type Node } from "yaml";
import type {
  Collection,
  DataRecord,
  DataStats,
  Diagnostic,
  SiteConfig,
  SourcePos,
} from "../contracts/index.ts";
import { applyDates } from "./checks/dates.ts";
import { checkReferences } from "./checks/references.ts";
import { checkUnique } from "./checks/unique.ts";
import { parseCsv } from "./csv.ts";
import { checkFieldSizes, checkRecordCount, checkSourceBytes, dataLimitsOf } from "./limits.ts";
import { readLock, type DataLock } from "./lock.ts";
import { resolveNpmSource } from "./package-source.ts";
import { skippedSummary } from "./policy.ts";
import { fieldPositionsOf, keyPositionsOf, keyText, lineIndex, mappingPairs, nodePos, sourcePosOf } from "./positions.ts";
import { readRemoteSource } from "./remote-source.ts";
import { compileSchemas, validateRecords } from "./schema.ts";
import type { SourceFormat } from "./schema-fix.ts";

/** What {@link loadCollections} read. */
export interface CollectionsResult {
  /** Collections keyed by name, in config order; a source that failed is absent. */
  readonly collections: Readonly<Record<string, Collection>>;
  /** Every finding, in the order it was made. */
  readonly diagnostics: readonly Diagnostic[];
  /** What the build read and left out, for `doctor` and the build summary. */
  readonly stats: DataStats;
}

/** Options of {@link loadCollections}. */
export interface LoadCollectionsOptions {
  /** Absolute site root, where `mizzen.yml`, the lock file, and `node_modules` live. */
  readonly root: string;
  /** The loaded config. */
  readonly config: SiteConfig;
}

/** True when a source is a URL or a package address rather than a path in the site. */
function isAddress(source: string): boolean {
  return /^[a-z][a-z\d+.-]*:/i.test(source);
}

/** A position at the start of the config file, used when the exact source line cannot be found. */
function atConfig(): SourcePos {
  return { file: "mizzen.yml", line: 1, column: 1, endLine: 1, endColumn: 1 };
}

/**
 * Where a collection's `source` is written in `mizzen.yml`, so a source-level problem points at the config line.
 * The search is literal and first-match; a site without a config file gets the start of a path that does not exist.
 */
function configPosition(root: string, source: string): SourcePos {
  let text: string;
  try {
    text = readFileSync(resolve(root, "mizzen.yml"), "utf8");
  } catch {
    return atConfig();
  }
  const index = lineIndex(text);
  const offset = text.indexOf(source);
  if (offset < 0) return atConfig();
  const begin = lineColumnAt(index, offset);
  const finish = lineColumnAt(index, offset + source.length - 1);
  return {
    file: "mizzen.yml",
    line: begin.line,
    column: begin.column,
    endLine: finish.line,
    endColumn: finish.column,
  };
}

/** The 1-based line and code-point column of `offset`, matching {@link lineIndex}. */
function lineColumnAt(
  index: { readonly text: string; readonly starts: readonly number[] },
  offset: number,
): { readonly line: number; readonly column: number } {
  let line = 1;
  for (let i = 0; i < index.starts.length; i++) {
    if (index.starts[i]! > offset) break;
    line = i + 1;
  }
  let column = 1;
  for (const _ of index.text.slice(index.starts[line - 1]!, offset)) column += 1;
  return { line, column };
}

/** A plain own-key copy of a parsed mapping, so a key such as `__proto__` is a field and not the prototype. */
function plainOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>)) {
    Object.defineProperty(copy, key, {
      value: (value as Record<string, unknown>)[key],
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return copy;
}

/** The scalar id of a record, as the config names it or as `id`; `undefined` when it is missing or not a scalar. */
function idOf(fields: Readonly<Record<string, unknown>>, idField: string): string | undefined {
  const value = fields[idField];
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

/** The format a source's fix suggestions are written in; a source that loaded has one of the three kinds. */
function formatOf(source: string): SourceFormat {
  return kindOf(source) ?? "yaml";
}

/** The source kind from an address or path, ignoring a URL's query and fragment. */
function kindOf(source: string): "csv" | "yaml" | "json" | undefined {
  const path = source.split(/[?#]/, 1)[0] ?? source;
  const match = /\.([a-z\d]+)$/i.exec(path);
  const extension = match?.[1]?.toLowerCase();
  if (extension === "csv") return "csv";
  if (extension === "yml" || extension === "yaml") return "yaml";
  if (extension === "json") return "json";
  return undefined;
}

/** The offset in `text` a JSON parser's `position N` names, or 0 when the message has none. */
function jsonOffset(message: string): number {
  const match = /position (\d+)/.exec(message);
  return match ? Number(match[1]) : 0;
}

/** The span of a parser message, or the start of the file. */
function errorPos(text: string, file: string, offset: number): SourcePos {
  const index = lineIndex(text);
  const begin = lineColumnAt(index, Math.min(offset, Math.max(0, text.length - 1)));
  return { file, line: begin.line, column: begin.column, endLine: begin.line, endColumn: begin.column };
}

/** Builds records from a parsed YAML or JSON document and its JS value. */
function recordsOfDocument(
  collection: string,
  file: string,
  text: string,
  document: Document.Parsed,
  idField: string,
  diagnostics: Diagnostic[],
): DataRecord[] | undefined {
  const index = lineIndex(text);
  const contents = document.contents as Node | null;
  if (contents === null) return [];
  const value = document.toJS() as unknown;

  if (isSeq(contents)) {
    const list = Array.isArray(value) ? value : [];
    const records: DataRecord[] = [];
    for (let position = 0; position < contents.items.length; position++) {
      const item = contents.items[position] as Node;
      const fields = plainOf(list[position]);
      if (fields === undefined) {
        diagnostics.push({
          id: "data.record-not-mapping",
          severity: "error",
          message: `Record ${position + 1} of "${collection}" is not a mapping of fields.`,
          pos: sourcePosOf(nodePos(index, file, item)),
          help: "Write each record as `field: value` pairs.",
        });
        continue;
      }
      const id = idOf(fields, idField);
      if (id === undefined) {
        diagnostics.push({
          id: "data.record-missing-id",
          severity: "error",
          message: `A record of "${collection}" has no "${idField}" field to use as its id.`,
          pos: sourcePosOf(nodePos(index, file, item)),
          help: `Add a scalar \`${idField}\` field, or set \`collections.${collection}.id\` to another field.`,
        });
        continue;
      }
      records.push({
        id,
        fields,
        position: nodePos(index, file, item),
        fieldPositions: fieldPositionsOf(index, file, item),
        keyPositions: keyPositionsOf(index, file, item),
      });
    }
    return records;
  }

  if (isMap(contents)) {
    const map = plainOf(value) ?? {};
    const records: DataRecord[] = [];
    for (const pair of mappingPairs(contents)) {
      const id = keyText(pair);
      const valueNode = pair.value as Node | null;
      const fields = id === undefined ? undefined : plainOf(map[id]);
      if (id === undefined || valueNode === null || typeof valueNode !== "object" || fields === undefined) {
        diagnostics.push({
          id: "data.record-not-mapping",
          severity: "error",
          message: `An entry of "${collection}" is not a mapping of fields keyed by its id.`,
          pos: sourcePosOf(valueNode === null || typeof valueNode !== "object" ? nodePos(index, file, pair.key as Node) : nodePos(index, file, valueNode)),
          help: "Write each entry as `id:` followed by its fields.",
        });
        continue;
      }
      records.push({
        id,
        fields,
        position: nodePos(index, file, valueNode),
        fieldPositions: fieldPositionsOf(index, file, valueNode),
        keyPositions: keyPositionsOf(index, file, valueNode),
      });
    }
    return records;
  }

  diagnostics.push({
    id: "data.collection-shape",
    severity: "error",
    message: `Collection "${collection}" must be a list of records or a mapping of id to record.`,
    pos: sourcePosOf(nodePos(index, file, contents)),
    help: "Start the file with `- id: …` for a list, or `id:` followed by fields for a mapping.",
  });
  return undefined;
}

/** Reads the bytes and display path of one resolved local file, with its size checked before the text is held. */
async function localBytes(
  collection: string,
  file: string,
  display: string,
  limits: ReturnType<typeof dataLimitsOf>,
  diagnostics: Diagnostic[],
  pos: SourcePos,
): Promise<string | undefined> {
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    diagnostics.push({
      id: "data.source-missing",
      severity: "error",
      message: `Collection "${collection}" reads ${display}, which does not exist.`,
      pos,
      help: "Check `collections.<name>.source` in mizzen.yml.",
    });
    return undefined;
  }
  const tooLarge = checkSourceBytes(collection, display, size, limits);
  if (tooLarge !== undefined) {
    diagnostics.push(tooLarge);
    return undefined;
  }
  try {
    return await readFile(file, "utf8");
  } catch {
    diagnostics.push({
      id: "data.source-unreadable",
      severity: "error",
      message: `Collection "${collection}" cannot read ${display}.`,
      pos,
      help: "Point the collection at a readable file.",
    });
    return undefined;
  }
}

/** Reads a CSV or YAML/JSON source into records, adding every finding to `diagnostics`. */
function readText(
  collection: string,
  source: string,
  display: string,
  text: string,
  idField: string,
  diagnostics: Diagnostic[],
): DataRecord[] | undefined {
  const kind = kindOf(source);
  if (kind === undefined) {
    diagnostics.push({
      id: "data.source-kind",
      severity: "error",
      message: `Collection "${collection}" reads ${display}, whose kind is not supported.`,
      help: "Use a .yml, .yaml, .json, or .csv source.",
    });
    return undefined;
  }

  if (kind === "csv") {
    const parsed = parseCsv(text, display);
    diagnostics.push(...parsed.diagnostics);
    if (parsed.header.length === 0) return undefined;
    const records: DataRecord[] = [];
    for (const row of parsed.rows) {
      const id = idOf(row.fields, idField);
      if (id === undefined) {
        diagnostics.push({
          id: "data.record-missing-id",
          severity: "error",
          message: `A row of "${collection}" has no "${idField}" column to use as its id.`,
          pos: sourcePosOf(row.position),
          help: `Add a \`${idField}\` column, or set \`collections.${collection}.id\` to another column.`,
        });
        continue;
      }
      records.push({
        id,
        fields: { ...row.fields },
        position: row.position,
        fieldPositions: row.fieldPositions,
        keyPositions: parsed.headerPositions,
      });
    }
    return records;
  }

  if (kind === "json") {
    try {
      JSON.parse(text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      diagnostics.push({
        id: "data.invalid-json",
        severity: "error",
        message: `Invalid JSON in ${display}: ${message}`,
        pos: errorPos(text, display, jsonOffset(message)),
      });
      return undefined;
    }
  }

  const lineCounter = new LineCounter();
  const document = parseDocument(text, { lineCounter });
  if (document.errors.length > 0) {
    const error = document.errors[0]!;
    const start = error.linePos?.[0];
    diagnostics.push({
      id: kind === "json" ? "data.invalid-json" : "data.invalid-yaml",
      severity: "error",
      message: `Invalid ${kind === "json" ? "JSON" : "YAML"} in ${display}: ${error.message.split("\n")[0]}`,
      pos: {
        file: display,
        line: start?.line ?? 1,
        column: start?.col ?? 1,
        endLine: start?.line ?? 1,
        endColumn: start?.col ?? 1,
      },
    });
    return undefined;
  }

  return recordsOfDocument(collection, display, text, document, idField, diagnostics);
}

/**
 * Loads every collection the config declares, in config order. Each source is read once; a source that cannot be
 * read or parsed is reported and left out, and the lock file is validated whenever the site declares collections.
 */
export async function loadCollections(options: LoadCollectionsOptions): Promise<CollectionsResult> {
  const { root, config } = options;
  const diagnostics: Diagnostic[] = [];
  const collections: Record<string, Collection> = {};
  const names = Object.keys(config.collections);
  const configPositions: Record<string, SourcePos> = {};
  for (const name of names) configPositions[name] = configPosition(root, config.collections[name]!.source);
  const schemas = compileSchemas(root, config, configPositions, diagnostics);
  let read = 0;
  let skipped = 0;

  let lock: DataLock | undefined;
  let lockInvalid = false;
  if (names.length > 0) {
    const read = await readLock(root);
    lock = read.lock;
    lockInvalid = read.diagnostics.some((diagnostic) => diagnostic.severity === "error");
    diagnostics.push(...read.diagnostics);
  }

  for (const name of names) {
    const entry = config.collections[name]!;
    const limits = dataLimitsOf(name, entry);
    const configPos = configPositions[name]!;
    const idField = entry.id ?? "id";
    const source = entry.source;
    let display: string;
    let text: string | undefined;
    let packageInfo: Collection["package"];

    if (source.startsWith("npm:")) {
      if (lockInvalid) continue;
      const resolved = await resolveNpmSource(root, source);
      if (resolved.source === undefined) {
        diagnostics.push({ ...resolved.diagnostic!, pos: configPos });
        continue;
      }
      display = resolved.source.display;
      packageInfo = { name: resolved.source.name, version: resolved.source.version };
      let size: number;
      try {
        size = (await stat(resolved.source.file)).size;
      } catch {
        diagnostics.push({
          id: "data.source-missing",
          severity: "error",
          message: `Collection "${name}" reads ${display}, which cannot be read.`,
          pos: configPos,
          help: "Install the package, then run `mizzen data fetch`.",
        });
        continue;
      }
      const tooLarge = checkSourceBytes(name, display, size, limits);
      if (tooLarge !== undefined) {
        diagnostics.push(tooLarge);
        continue;
      }
      const pinned = lock?.sources[source];
      if (pinned === undefined) {
        diagnostics.push({
          id: "data.lock-missing",
          severity: "error",
          message: `Collection "${name}" reads "${source}", which has no entry in mizzen.lock.json.`,
          pos: configPos,
          help: "Run `mizzen data fetch` to pin the installed package.",
        });
        continue;
      }
      let bytes: Uint8Array;
      try {
        bytes = await readFile(resolved.source.file);
      } catch {
        diagnostics.push({
          id: "data.source-unreadable",
          severity: "error",
          message: `Collection "${name}" cannot read ${display}.`,
          pos: configPos,
          help: "Point the collection at a readable file inside the package.",
        });
        continue;
      }
      if (pinned.version !== resolved.source.version || pinned.bytes !== bytes.byteLength || pinned.sha256 !== sha256Of(bytes)) {
        diagnostics.push({
          id: "data.lock-mismatch",
          severity: "error",
          message: `Collection "${name}" reads "${source}", which no longer matches its lock entry.`,
          pos: configPos,
          help: "Run `mizzen data fetch` to pin the installed version again.",
        });
        continue;
      }
      text = new TextDecoder().decode(bytes);
    } else if (isAddress(source)) {
      if (lockInvalid) continue;
      const result = await readRemoteSource(root, source, lock ?? { version: 1, sources: {} }, limits);
      if (result.source === undefined) {
        diagnostics.push({ ...result.diagnostic!, pos: result.diagnostic!.pos ?? configPos });
        continue;
      }
      display = result.source.display;
      text = result.source.text;
    } else {
      const file = resolve(root, source);
      const rel = relative(root, file);
      if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
        diagnostics.push({
          id: "data.source-outside-root",
          severity: "error",
          message: `Collection "${name}" reads "${source}", which is outside the site root.`,
          pos: configPos,
          help: "Keep a collection source inside the site.",
        });
        continue;
      }
      display = rel.split(sep).join("/");
      text = await localBytes(name, file, display, limits, diagnostics, configPos);
      if (text === undefined) continue;
    }

    const records = readText(name, source, display, text, idField, diagnostics);
    if (records === undefined) continue;
    const tooMany = checkRecordCount(name, display, records.length, limits);
    if (tooMany !== undefined) {
      diagnostics.push(tooMany);
      continue;
    }
    diagnostics.push(...checkFieldSizes(name, records, limits));
    read += records.length;
    let kept: readonly DataRecord[] = records;
    const schema = schemas.schemas[name];
    if (schema !== undefined) {
      const validated = validateRecords(name, kept, schema, entry, formatOf(source), diagnostics);
      kept = validated.records;
      skipped += validated.skipped;
    }
    checkUnique(name, kept, entry, diagnostics);
    kept = applyDates(name, kept, entry.dates ?? [], diagnostics);
    collections[name] = {
      name,
      source,
      records: kept,
      ...(packageInfo === undefined ? {} : { package: packageInfo }),
    };
  }

  checkReferences(collections, config, diagnostics);
  const summary = skippedSummary(skipped);
  if (summary !== undefined) diagnostics.push(summary);

  return {
    collections,
    diagnostics,
    stats: {
      collections: names.length,
      loaded: Object.keys(collections).length,
      records: read,
      skipped,
      schemas: Object.keys(schemas.schemas).length,
      unchecked: schemas.unchecked,
    },
  };
}

/** SHA-256 of bytes, imported here to keep `collections.ts` independent of the lock's shape. */
function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
