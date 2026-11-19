/**
 * Local SQLite and NDJSON sources: extraction outside a build, and the locked result a build reads. A SQLite database
 * is opened read-only inside one read transaction, and its query must be one read statement. NDJSON is read line by
 * line, so a large file is never held whole. Both produce the same canonical NDJSON, sorted by the record key, so
 * equivalent data gives the same bytes and the same catalog.
 *
 * Every problem is a diagnostic, never a throw. A failed extraction writes nothing: the caller writes the store and
 * the lock only after every collection succeeded. `docs/db-input.md` states each default and diagnostic id.
 */
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { relative, resolve, sep } from "node:path";
import type { CollectionConfig, DataRecord, Diagnostic, RecordPos, SourcePos } from "../contracts/index.ts";
import type { SqliteSourceConfig } from "../contracts/config.ts";
import { checkFieldSizes, dataLimitsOf, type DataLimits } from "./limits.ts";
import { canonicalJson, sha256, storedPath, type DataLock, type LockedExtraction } from "./lock.ts";
import { readQueryProblem } from "./sqlite-query.ts";

/** A collection whose records are extracted and locked rather than read in place. */
export interface ExtractedCollection {
  /** The collection's name. */
  readonly name: string;
  /** The source as the config writes it. */
  readonly source: string;
  /** The records, sorted by key. */
  readonly records: readonly DataRecord[];
  /** The canonical NDJSON result, ready to store. */
  readonly bytes: Uint8Array;
  /** The lock entry this result needs. */
  readonly locked: LockedExtraction;
}

/** What extracting every extraction-backed collection found. */
export interface ExtractSiteResult {
  /** Results by collection name, in config order; empty when any collection failed. */
  readonly collections: readonly ExtractedCollection[];
  /** Every finding, in the order it was made. */
  readonly diagnostics: readonly Diagnostic[];
}

/** True for a source a build reads from a locked extraction: a SQLite database or an NDJSON file. */
export function isExtractedSource(source: string): boolean {
  return isSqliteSource(source) || isNdjsonSource(source);
}

/** True for a SQLite database path. */
export function isSqliteSource(source: string): boolean {
  return /\.(?:sqlite|sqlite3|db)$/i.test(source.split(/[?#]/, 1)[0] ?? source);
}

/** True for an NDJSON (or JSON Lines) path. */
export function isNdjsonSource(source: string): boolean {
  return /\.(?:ndjson|jsonl)$/i.test(source.split(/[?#]/, 1)[0] ?? source);
}

/** A diagnostic position at row `line` of a source, before the exact column is known. */
function atRow(file: string, line: number): SourcePos {
  return { file, line, column: 1, endLine: line, endColumn: 1 };
}

/** A record position at row `line` of an extracted result. */
function atRecordRow(file: string, line: number): RecordPos {
  return { file, startLine: line, startColumn: 1, endLine: line, endColumn: 1 };
}

/** A plain own-key copy of a parsed object, so a key such as `__proto__` stays a field. */
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

/** One extracted row before it becomes a record: its fields and the row it came from. */
interface Row {
  readonly fields: Readonly<Record<string, unknown>>;
  readonly id: string;
}

/** The id column: `sqlite.key`, else the collection's `id`, else `id`. */
function keyFieldOf(name: string, entry: CollectionConfig): string {
  return entry.sqlite?.key ?? entry.id ?? "id";
}

/** The query identity a lock records: a readable id and a hash of everything that changes the result. */
export function extractionIdentityOf(name: string, entry: CollectionConfig): { readonly query: string; readonly querySha256: string } {
  if (isNdjsonSource(entry.source)) {
    return {
      query: "ndjson",
      querySha256: sha256(JSON.stringify({ kind: "ndjson", id: entry.id ?? "id" })),
    };
  }
  const sqlite = entry.sqlite;
  return {
    query: sqlite?.id ?? name,
    querySha256: sha256(JSON.stringify({
      kind: "sqlite",
      query: sqlite?.query ?? "",
      params: sqlite?.params ?? [],
      key: keyFieldOf(name, entry),
      order: sqlite?.order ?? [],
      binary: sqlite?.binary ?? "base64",
    })),
  };
}

/** The diagnostic for a source path outside the site root. */
function outsideRoot(name: string, source: string): Diagnostic {
  return {
    id: "data.source-outside-root",
    severity: "error",
    message: `Collection "${name}" reads "${source}", which is outside the site root.`,
    help: "Keep a collection source inside the site.",
  };
}

/** The source's path relative to the site root with `/` separators, or a diagnostic when it leaves the root. */
function displayOf(root: string, source: string, name: string): { readonly display?: string; readonly diagnostic?: Diagnostic } {
  const file = resolve(root, source);
  const rel = relative(root, file);
  if (rel.startsWith(`..${sep}`) || rel === ".." || rel === "" || rel.startsWith(sep)) {
    return { diagnostic: outsideRoot(name, source) };
  }
  return { display: rel.split(sep).join("/") };
}

/** The size a value writes, in characters; a non-string is measured by its JSON text. */
function valueSize(value: unknown): number {
  if (typeof value === "string") return [...value].length;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

/** A code-point comparison, so ordering never depends on the host locale. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A deterministic comparison for SQLite values: null last, numbers below text, then code point. */
function compareValue(a: unknown, b: unknown): number {
  const rank = (value: unknown): number => (value === null || value === undefined ? 3 : typeof value === "number" ? 0 : typeof value === "string" ? 1 : 2);
  const left = rank(a);
  const right = rank(b);
  if (left !== right) return left - right;
  if (typeof a === "number" && typeof b === "number") return a === b ? 0 : a < b ? -1 : 1;
  if (typeof a === "string" && typeof b === "string") return compareText(a, b);
  return compareText(canonicalJson(a), canonicalJson(b));
}

/** Converts one SQLite value; a value with no contract is an error naming the column. */
function sqliteValue(
  name: string,
  column: string,
  value: unknown,
  binary: "base64" | "error",
): { readonly value?: unknown; readonly diagnostic?: Diagnostic } {
  if (value === null) return { value: null };
  if (typeof value === "string" || typeof value === "number") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      return {
        diagnostic: {
          id: "data.sqlite-type",
          severity: "error",
          message: `Collection "${name}" reads column "${column}", whose value is not a finite number.`,
          help: "Store a finite number, or convert the column in the query.",
        },
      };
    }
    return { value };
  }
  if (typeof value === "bigint") {
    const number = Number(value);
    if (!Number.isSafeInteger(number)) {
      return {
        diagnostic: {
          id: "data.sqlite-type",
          severity: "error",
          message: `Collection "${name}" reads column "${column}", whose integer is outside the safe range.`,
          help: "Cast the column to TEXT in the query, or shorten the value.",
        },
      };
    }
    return { value: number };
  }
  if (value instanceof Uint8Array) {
    if (binary === "error") {
      return {
        diagnostic: {
          id: "data.sqlite-type",
          severity: "error",
          message: `Collection "${name}" reads column "${column}", which holds a binary value.`,
          help: "Set `sqlite.binary: base64` to write it, or cast the column in the query.",
        },
      };
    }
    return { value: Buffer.from(value).toString("base64") };
  }
  return {
    diagnostic: {
      id: "data.sqlite-type",
      severity: "error",
      message: `Collection "${name}" reads column "${column}", whose value has an unsupported type.`,
      help: "Select TEXT, INTEGER, REAL, or BLOB, or convert the column in the query.",
    },
  };
}

/** Turns sorted rows into records with a stable position: row n of the result has line n. */
function recordsOf(name: string, rows: readonly Row[], display: string, limits: DataLimits): { readonly records?: DataRecord[]; readonly diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const records: DataRecord[] = rows.map((row, position) => ({
    id: row.id,
    fields: row.fields,
    position: atRecordRow(display, position + 1),
    fieldPositions: Object.fromEntries(Object.keys(row.fields).map((field) => [field, atRecordRow(display, position + 1)])),
    keyPositions: Object.fromEntries(Object.keys(row.fields).map((field) => [field, atRecordRow(display, position + 1)])),
  }));
  diagnostics.push(...checkFieldSizes(name, records, limits));
  return { records, diagnostics };
}

/** The canonical result: one record per line, keys sorted, one LF after each line and none for an empty result. */
export function extractionText(records: readonly DataRecord[]): string {
  if (records.length === 0) return "";
  return `${records.map((record) => canonicalJson(record.fields)).join("\n")}\n`;
}

/** The row cap error, naming the line when the source has one. */
function rowLimit(name: string, source: string, line: number | undefined, limits: DataLimits): Diagnostic {
  return {
    id: "data.too-many-records",
    severity: "error",
    message: `Collection "${name}" reads more records than allowed from ${source}${line === undefined ? "" : ` at line ${line}`}; the limit is ${limits.records}.`,
    help: `Raise collections.${name}.limits.records in mizzen.yml, or split the source.`,
  };
}

/** One error for a source over its byte limit. */
function byteLimit(name: string, source: string, bytes: number, limits: DataLimits): Diagnostic {
  return {
    id: "data.source-too-large",
    severity: "error",
    message: `Collection "${name}" reads ${bytes} bytes from ${source}; the limit is ${limits.bytes}.`,
    help: `Raise collections.${name}.limits.bytes in mizzen.yml, or split the source.`,
  };
}

/** Reads one local SQLite source with a read-only connection and one read transaction. */
async function extractSqlite(
  root: string,
  name: string,
  entry: CollectionConfig,
  sqlite: SqliteSourceConfig,
  display: string,
  limits: DataLimits,
): Promise<{ readonly extracted?: ExtractedCollection; readonly diagnostics: Diagnostic[] }> {
  const diagnostics: Diagnostic[] = [];
  const problem = readQueryProblem(sqlite.query);
  if (problem !== undefined) {
    return {
      diagnostics: [{
        id: "config.sqlite-query",
        severity: "error",
        message: `Collection "${name}" names a SQLite query that is not one read statement: ${problem}.`,
        help: "Write one SELECT (or WITH … SELECT) statement; a read-only extraction refuses writes.",
      }],
    };
  }
  const file = resolve(root, entry.source);
  const keyField = keyFieldOf(name, entry);
  let Database: typeof import("node:sqlite").DatabaseSync;
  try {
    ({ DatabaseSync: Database } = await import("node:sqlite"));
  } catch {
    return {
      diagnostics: [{
        id: "data.sqlite-unavailable",
        severity: "error",
        message: `Collection "${name}" reads ${display}, but this Node has no \`node:sqlite\` module.`,
        help: "Run Node 24 or later.",
      }],
    };
  }

  let db: import("node:sqlite").DatabaseSync | undefined;
  try {
    db = new Database(file, { readOnly: true });
    db.exec("PRAGMA query_only = ON");
    db.exec("BEGIN");
    const statement = db.prepare(sqlite.query);
    const columns = statement.columns().map((column) => column.name);
    const seen = new Set<string>();
    for (const column of columns) {
      if (seen.has(column)) {
        diagnostics.push({
          id: "data.sqlite-column",
          severity: "error",
          message: `Collection "${name}" selects column "${column}" twice; the query must give each column one name.`,
          help: "Alias one of the columns, such as `SELECT a, b AS b2`.",
        });
      }
      seen.add(column);
    }
    if (!columns.includes(keyField)) {
      diagnostics.push({
        id: "data.sqlite-key",
        severity: "error",
        message: `Collection "${name}" uses column "${keyField}" as its key, but the query does not select it.`,
        help: `Select \`${keyField}\`, or set \`collections.${name}.sqlite.key\` to a selected column.`,
      });
    }
    if (diagnostics.length > 0) {
      db.exec("ROLLBACK");
      return { diagnostics };
    }

    const rows: Row[] = [];
    const iterator = statement.iterate(...(sqlite.params ?? []));
    for (const raw of iterator) {
      if (rows.length >= limits.records) {
        diagnostics.push(rowLimit(name, display, undefined, limits));
        break;
      }
      const row = plainOf(raw);
      if (row === undefined) {
        diagnostics.push({
          id: "data.sqlite-type",
          severity: "error",
          message: `Collection "${name}" read a row from ${display} that is not a record.`,
          help: "Select named columns, not a whole table row.",
        });
        break;
      }
      const fields: Record<string, unknown> = {};
      for (const column of columns) {
        const mapped = sqliteValue(name, column, row[column], sqlite.binary ?? "base64");
        if (mapped.diagnostic !== undefined) {
          diagnostics.push(mapped.diagnostic);
          break;
        }
        fields[column] = mapped.value;
      }
      if (diagnostics.length > 0) break;
      const idValue = fields[keyField];
      const id = typeof idValue === "string" ? idValue : typeof idValue === "number" ? String(idValue) : undefined;
      if (id === undefined) {
        diagnostics.push({
          id: "data.record-missing-id",
          severity: "error",
          message: `A row of "${name}" has no scalar "${keyField}" value to use as its id.`,
          help: `Add a scalar \`${keyField}\` column, or set \`collections.${name}.sqlite.key\` to another column.`,
        });
        break;
      }
      rows.push({ fields, id });
    }
    if (diagnostics.length > 0) {
      db.exec("ROLLBACK");
      return { diagnostics };
    }
    db.exec("COMMIT");
    const extracted = finishExtraction(name, entry, display, rows, limits, diagnostics);
    return extracted === undefined ? { diagnostics } : { extracted, diagnostics };
  } catch (err) {
    try {
      db?.exec("ROLLBACK");
    } catch {
      // A failed BEGIN or an already-finished transaction has nothing to roll back.
    }
    const detail = (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "unknown error";
    diagnostics.push({
      id: "data.sqlite-query",
      severity: "error",
      message: `Collection "${name}" cannot run its SQLite query on ${display}: ${detail}`,
      help: "Check the query and the database; an extraction reads only, never writes.",
    });
    return { diagnostics };
  } finally {
    try {
      db?.close();
    } catch {
      // A connection that failed to open or already closed needs no second close.
    }
  }
}

/** Sorts, deduplicates, checks the byte cap, and serializes one extraction. */
function finishExtraction(
  name: string,
  entry: CollectionConfig,
  display: string,
  rows: Row[],
  limits: DataLimits,
  diagnostics: Diagnostic[],
): ExtractedCollection | undefined {
  const sqlite = entry.sqlite;
  const order = isSqliteSource(entry.source) ? sqlite?.order ?? [] : [];
  const keyField = isSqliteSource(entry.source) ? keyFieldOf(name, entry) : entry.id ?? "id";
  const sorted = [...rows].sort((a, b) => {
    for (const field of order) {
      if (field === keyField) continue;
      const compared = compareValue(a.fields[field], b.fields[field]);
      if (compared !== 0) return compared;
    }
    return compareText(a.id, b.id);
  });
  const seen = new Map<string, number>();
  for (let position = 0; position < sorted.length; position++) {
    const row = sorted[position]!;
    const first = seen.get(row.id);
    if (first !== undefined) {
      diagnostics.push({
        id: "data.record-duplicate-id",
        severity: "error",
        message: `Rows ${first + 1} and ${position + 1} of "${name}" both use "${row.id}" as their id.`,
        pos: atRow(display, position + 1),
        help: `Give each row a unique \`${keyField}\` value.`,
      });
      continue;
    }
    seen.set(row.id, position);
  }
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) return undefined;

  const built = recordsOf(name, sorted, display, limits);
  diagnostics.push(...built.diagnostics);
  if (built.records === undefined || diagnostics.some((diagnostic) => diagnostic.severity === "error")) return undefined;
  const text = extractionText(built.records);
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > limits.bytes) {
    diagnostics.push(byteLimit(name, display, bytes.byteLength, limits));
    return undefined;
  }
  const identity = extractionIdentityOf(name, entry);
  return {
    name,
    source: entry.source,
    records: built.records,
    bytes,
    locked: {
      source: entry.source,
      query: identity.query,
      querySha256: identity.querySha256,
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
      records: built.records.length,
    },
  };
}

/** The one line error for invalid JSON, with its line number. */
function invalidJson(name: string, display: string, line: number, detail: string): Diagnostic {
  return {
    id: "data.invalid-json",
    severity: "error",
    message: `Line ${line} of ${display} is not valid JSON: ${detail}`,
    pos: atRow(display, line),
    help: `Collection "${name}" reads one complete JSON object per line.`,
  };
}

/** Reads one local NDJSON source line by line, stopping at a record or byte limit. */
async function extractNdjson(
  root: string,
  name: string,
  entry: CollectionConfig,
  display: string,
  limits: DataLimits,
): Promise<{ readonly extracted?: ExtractedCollection; readonly diagnostics: Diagnostic[] }> {
  const diagnostics: Diagnostic[] = [];
  const file = resolve(root, entry.source);
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    return {
      diagnostics: [{
        id: "data.source-missing",
        severity: "error",
        message: `Collection "${name}" reads ${display}, which does not exist.`,
        help: "Check `collections.<name>.source` in mizzen.yml.",
      }],
    };
  }
  if (size > limits.bytes) return { diagnostics: [byteLimit(name, display, size, limits)] };

  const idField = entry.id ?? "id";
  const rows: Row[] = [];
  const stream = createReadStream(file, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  let line = 0;
  let read = 0;
  let stopped = false;
  stream.on("data", (chunk: string | Buffer) => {
    read += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
    if (read > limits.bytes && !stopped) {
      stopped = true;
      diagnostics.push(byteLimit(name, display, read, limits));
      reader.close();
      stream.destroy();
    }
  });
  try {
    for await (const text of reader) {
      line += 1;
      if (text.trim() === "") continue;
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch (err) {
        diagnostics.push(invalidJson(name, display, line, err instanceof Error ? err.message : String(err)));
        break;
      }
      const fields = plainOf(value);
      if (fields === undefined) {
        diagnostics.push({
          id: "data.record-not-mapping",
          severity: "error",
          message: `Line ${line} of ${display} is not a record: it must be a JSON object of fields.`,
          pos: atRow(display, line),
          help: `Write one \`{ "field": value }\` object per line.`,
        });
        break;
      }
      if (rows.length >= limits.records) {
        diagnostics.push(rowLimit(name, display, line, limits));
        break;
      }
      const idValue = fields[idField];
      const id = typeof idValue === "string" ? idValue : typeof idValue === "number" ? String(idValue) : undefined;
      if (id === undefined) {
        diagnostics.push({
          id: "data.record-missing-id",
          severity: "error",
          message: `Line ${line} of ${display} has no scalar "${idField}" field to use as its id.`,
          pos: atRow(display, line),
          help: `Add a scalar \`${idField}\` field, or set \`collections.${name}.id\` to another field.`,
        });
        break;
      }
      rows.push({ fields, id });
    }
  } finally {
    reader.close();
    stream.destroy();
  }
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) return { diagnostics };
  const extracted = finishExtraction(name, entry, display, rows, limits, diagnostics);
  return extracted === undefined ? { diagnostics } : { extracted, diagnostics };
}

/** Extracts one collection from its SQLite or NDJSON source. */
export async function extractCollection(
  root: string,
  name: string,
  entry: CollectionConfig,
): Promise<{ readonly extracted?: ExtractedCollection; readonly diagnostics: Diagnostic[] }> {
  const limits = dataLimitsOf(name, entry);
  const display = displayOf(root, entry.source, name);
  if (display.display === undefined) return { diagnostics: [display.diagnostic!] };
  if (isSqliteSource(entry.source)) {
    if (entry.sqlite === undefined) {
      return {
        diagnostics: [{
          id: "config.sqlite-query",
          severity: "error",
          message: `Collection "${name}" reads a SQLite file but names no \`sqlite.query\`.`,
          help: "Add `sqlite: { query: SELECT … }` to the collection.",
        }],
      };
    }
    return extractSqlite(root, name, entry, entry.sqlite, display.display, limits);
  }
  if (isNdjsonSource(entry.source)) return extractNdjson(root, name, entry, display.display, limits);
  return { diagnostics: [] };
}

/** Extracts every SQLite and NDJSON collection; nothing is written and one failure leaves every result inactive. */
export async function extractSite(root: string, config: { readonly collections: Readonly<Record<string, CollectionConfig>> }): Promise<ExtractSiteResult> {
  const collections: ExtractedCollection[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const [name, entry] of Object.entries(config.collections)) {
    if (!isExtractedSource(entry.source)) continue;
    const result = await extractCollection(root, name, entry);
    diagnostics.push(...result.diagnostics);
    if (result.extracted !== undefined) collections.push(result.extracted);
  }
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) return { collections: [], diagnostics };
  return { collections, diagnostics };
}

/** What reading a locked extraction found. */
export interface LockedReadResult {
  /** The records, absent when a diagnostic explains why. */
  readonly records?: readonly DataRecord[];
  /** The one problem that stopped the read. */
  readonly diagnostic?: Diagnostic;
}

/**
 * Reads the locked result of one collection. A missing, stale, or changed result is one diagnostic; the source file is
 * never opened, so a build stays offline and deterministic.
 */
export async function readLockedExtraction(
  root: string,
  name: string,
  entry: CollectionConfig,
  lock: DataLock,
): Promise<LockedReadResult> {
  const limits = dataLimitsOf(name, entry);
  const locked = lock.extractions?.[name];
  if (locked === undefined) {
    return {
      diagnostic: {
        id: "data.extraction-missing",
        severity: "error",
        message: `Collection "${name}" reads "${entry.source}", which has no locked extraction.`,
        help: "Run `mizzen data extract` to read and lock it.",
      },
    };
  }
  const identity = extractionIdentityOf(name, entry);
  if (locked.source !== entry.source || locked.query !== identity.query || locked.querySha256 !== identity.querySha256) {
    return {
      diagnostic: {
        id: "data.extraction-stale",
        severity: "error",
        message: `Collection "${name}" reads "${entry.source}", whose locked extraction no longer matches its source or query.`,
        help: "Run `mizzen data extract` to lock the current result.",
      },
    };
  }
  if (locked.bytes > limits.bytes) {
    return { diagnostic: byteLimit(name, entry.source, locked.bytes, limits) };
  }
  const path = storedPath(root, locked.sha256);
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch {
    return {
      diagnostic: {
        id: "data.store-missing",
        severity: "error",
        message: `The locked result for "${name}" is missing from .mizzen/data/${locked.sha256}.`,
        help: "Run `mizzen data extract` to store it again.",
      },
    };
  }
  if (bytes.byteLength !== locked.bytes || sha256(bytes) !== locked.sha256) {
    return {
      diagnostic: {
        id: "data.store-mismatch",
        severity: "error",
        message: `The locked result for "${name}" does not match its lock entry.`,
        help: "Run `mizzen data extract` to restore the pinned result.",
      },
    };
  }
  const display = `.mizzen/data/${locked.sha256}`;
  const text = new TextDecoder().decode(bytes);
  const lines = text === "" ? [] : text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== locked.records) {
    return {
      diagnostic: {
        id: "data.store-mismatch",
        severity: "error",
        message: `The locked result for "${name}" holds ${lines.length} records; its lock entry says ${locked.records}.`,
        help: "Run `mizzen data extract` to write it again.",
      },
    };
  }
  const records: DataRecord[] = [];
  for (let position = 0; position < lines.length; position++) {
    let value: unknown;
    try {
      value = JSON.parse(lines[position]!);
    } catch {
      return {
        diagnostic: {
          id: "data.store-mismatch",
          severity: "error",
          message: `Line ${position + 1} of the locked result for "${name}" is not valid JSON.`,
          help: "Run `mizzen data extract` to write it again.",
        },
      };
    }
    const fields = plainOf(value);
    if (fields === undefined) {
      return {
        diagnostic: {
          id: "data.store-mismatch",
          severity: "error",
          message: `Line ${position + 1} of the locked result for "${name}" is not a record.`,
          help: "Run `mizzen data extract` to write it again.",
        },
      };
    }
    const idField = isSqliteSource(entry.source) ? keyFieldOf(name, entry) : entry.id ?? "id";
    const idValue = fields[idField];
    const id = typeof idValue === "string" ? idValue : typeof idValue === "number" ? String(idValue) : undefined;
    if (id === undefined) {
      return {
        diagnostic: {
          id: "data.store-mismatch",
          severity: "error",
          message: `Record ${position + 1} of the locked result for "${name}" has no "${idField}" field.`,
          help: "Run `mizzen data extract` to write it again.",
        },
      };
    }
    const pos = atRecordRow(display, position + 1);
    records.push({
      id,
      fields,
      position: pos,
      fieldPositions: Object.fromEntries(Object.keys(fields).map((field) => [field, pos])),
      keyPositions: Object.fromEntries(Object.keys(fields).map((field) => [field, pos])),
    });
  }
  return { records };
}

/** The source path a record position names, for an extraction loaded by a build. */
export { displayOf as extractionDisplayOf };

/** The value size helper is shared with the schema diagnostics; kept exported for a direct test. */
export { valueSize as extractionValueSize };
